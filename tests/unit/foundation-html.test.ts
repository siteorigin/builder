/**
 * The HTML Foundation sections actually render, as an exported site prerenders it: each generated component is
 * compiled for the server, bundled with Svelte's server runtime and rendered with the properties an author set.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ComponentDefinition, InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { installComponent, makeInstance } from '@engine/install';
import { STYLES_DIR, defFile, generateProject, pageFile, resolveInstanceProps } from '@generator/index';
import { applyOperations } from '@engine/apply';

const COMPONENTS = [
  'stats.row',
  'shell.footer',
  'shell.header',
  'team.grid',
  'testimonials.grid',
  'logos.strip',
  'features.grid',
  'media.gallery',
  'pricing.plans',
  'faq.list',
  'contact.details',
  'hero.centered',
  'hero.split',
  'intro.page',
  'content.media',
  'cta.banner',
  'content.pages',
  'content.news',
  'content.article',
  'data.table',
  'media.video',
  'media.carousel'
] as const;
type ComponentId = (typeof COMPONENTS)[number];

interface Rendered {
  render: (component: unknown, options: { props: Record<string, unknown> }) => { body: string };
  components: Record<string, unknown>;
}

const GEN = '\0gen:';

/** Every listed component, generated into one project and bundled for the server. */
async function bundleComponents(): Promise<{ module: Rendered; files: Map<string, string>; defs: Record<string, ComponentDefinition>; state: ProjectState; dir: string }> {
  const s = createStarterState('business', 'Test Studio', false);
  const home = s.pages[s.site.homePageId];
  const defs: Record<string, ComponentDefinition> = {};
  for (const componentId of COMPONENTS) {
    const existing = Object.values(s.components).find((d) => d.componentId === componentId);
    const def = existing ?? s.components[installComponent(s, componentId)];
    defs[componentId] = def;
    if (!existing) {
      const node = makeInstance(def, {});
      home.nodes[node.id] = node;
      home.rootIds.push(node.id);
    }
  }
  const files = generateProject(s);
  const entry = [
    "export { render } from 'svelte/server';",
    ...COMPONENTS.map((id, i) => `import C${i} from ${JSON.stringify(GEN + defFile(defs[id]))};`),
    `export const components = { ${COMPONENTS.map((id, i) => `${JSON.stringify(id)}: C${i}`).join(', ')} };`
  ].join('\n');
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    ssr: { noExternal: true },
    plugins: [
      {
        name: 'generated-site',
        enforce: 'pre',
        resolveId(id, importer) {
          if (id === '\0entry' || id.startsWith(GEN)) return id;
          if (id === '$app/paths' || id === '$app/state' || id === '$app/navigation') return `\0${id}`;
          if (importer?.startsWith(GEN) && id.startsWith('.')) {
            const path = posix.join(posix.dirname(importer.slice(GEN.length)), id);
            if (files.has(path)) return GEN + path;
          }
          return null;
        },
        load(id) {
          if (id === '\0entry') return entry;
          if (id === '\0$app/paths') return "export const resolve = (p) => p; export const asset = (p) => '/' + p; export const base = '';";
          if (id === '\0$app/state') return "export const page = { get route() { return { id: globalThis.soTestRouteId ?? '/' }; }, url: new URL('https://site.test/') };";
          if (id === '\0$app/navigation') return 'export const afterNavigate = () => {}; export const beforeNavigate = () => {};';
          if (!id.startsWith(GEN)) return null;
          const path = id.slice(GEN.length);
          const source = files.get(path)!;
          const code = path.endsWith('.svelte') ? compile(source, { filename: path, generate: 'server', runes: true }).js.code : source;
          return { code, moduleType: 'js' };
        }
      }
    ],
    build: { write: false, ssr: true, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'esm', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The components did not bundle');
  const dir = mkdtempSync(join(tmpdir(), 'so-foundation-html-'));
  const file = join(dir, 'components.mjs');
  writeFileSync(file, chunk.code);
  return { module: (await import(pathToFileURL(file).href)) as Rendered, files, defs, state: s, dir };
}

/**
 * A page of a project as the exported site prerenders it: its generated route, with every generated file it imports,
 * compiled for the server and rendered. Returns the page's body HTML without hydration comments.
 */
async function renderRoute(state: ProjectState, pageId: string): Promise<string> {
  const files = generateProject(state);
  const route = pageFile(state.pages[pageId]);
  const entry = `export { render } from 'svelte/server';\nexport { default as Page } from ${JSON.stringify(GEN + route)};`;
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    ssr: { noExternal: true },
    plugins: [
      {
        name: 'generated-route',
        enforce: 'pre',
        resolveId(id, importer) {
          if (id === '\0entry' || id.startsWith(GEN)) return id;
          if (id === '$app/paths' || id === '$app/state' || id === '$app/navigation') return `\0${id}`;
          if (importer?.startsWith(GEN) && id.startsWith('.')) {
            const path = posix.join(posix.dirname(importer.slice(GEN.length)), id);
            if (files.has(path)) return GEN + path;
          }
          return null;
        },
        load(id) {
          if (id === '\0entry') return entry;
          if (id === '\0$app/paths') return "export const resolve = (p) => p; export const asset = (p) => '/' + p; export const base = '';";
          if (id === '\0$app/state') return "export const page = { get route() { return { id: globalThis.soTestRouteId ?? '/' }; }, url: new URL('https://site.test/') };";
          if (id === '\0$app/navigation') return 'export const afterNavigate = () => {}; export const beforeNavigate = () => {};';
          if (!id.startsWith(GEN)) return null;
          const path = id.slice(GEN.length);
          const source = files.get(path)!;
          const code = path.endsWith('.svelte') ? compile(source, { filename: path, generate: 'server', runes: true }).js.code : source;
          return { code, moduleType: 'js' };
        }
      }
    ],
    build: { write: false, ssr: true, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'esm', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The route did not bundle');
  const dir = mkdtempSync(join(tmpdir(), 'so-route-html-'));
  try {
    const file = join(dir, 'route.mjs');
    writeFileSync(file, chunk.code);
    const mod = (await import(pathToFileURL(file).href)) as { render: Rendered['render']; Page: unknown };
    return mod.render(mod.Page, { props: {} }).body.replace(/<!--[\s\S]*?-->/g, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let bundle: Awaited<ReturnType<typeof bundleComponents>>;

beforeAll(async () => {
  bundle = await bundleComponents();
}, 60_000);

afterAll(() => {
  if (bundle?.dir) rmSync(bundle.dir, { recursive: true, force: true });
});

/** The component's HTML with these properties (the rest keep their defaults), without hydration comments. */
function html(componentId: ComponentId, props: Record<string, unknown> = {}): string {
  const { body } = bundle.module.render(bundle.module.components[componentId], { props });
  return body.replace(/<!--[\s\S]*?-->/g, '');
}

/** The HTML for a placement holding these authored (stored) property values, resolved the way the export resolves them. */
function authoredHtml(componentId: ComponentId, props: Record<string, unknown>, pageId?: string): string {
  const def = bundle.defs[componentId];
  const node: InstanceNode = { id: 'n_test', kind: 'instance', definitionId: def.id, props };
  return html(componentId, resolveInstanceProps(def, node, { state: bundle.state, pageId }));
}

/** The generated stylesheet for every component. */
function componentsCss(): string {
  return bundle.files.get(`${STYLES_DIR}/components.css`) ?? '';
}

const tags = (markup: string, tag: string) => [...markup.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]);
const EMPTY_HEADING = /<h[1-6]\b[^>]*>\s*<\/h[1-6]>/;
/** Matches an element carrying this exact class (not just a class that starts with it). */
const classed = (cls: string) => new RegExp(`class="(?:[^"]*\\s)?${cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s[^"]*)?"`);
const nodeClass = (componentId: string, nodeId: string) => `so-foundation-${componentId.replace('.', '-')}__${nodeId}`;

describe('stats.row', () => {
  it('puts each label (dt) before its figure (dd), keeping the figure visually first', () => {
    const out = html('stats.row', { items: [{ id: 'a', value: '15', label: 'Years in practice' }, { id: 'b', value: '98%', label: 'Clients who return' }] });
    const list = tags(out, 'dl');
    expect(list).toHaveLength(1);
    const groups = [...list[0].matchAll(/<div class="[^"]*so-foundation-stats-row__figure[^"]*">([\s\S]*?)<\/div>/g)].map((m) => m[1].replace(/\s+/g, ''));
    expect(groups).toEqual([
      expect.stringMatching(/^<dt[^>]*>Yearsinpractice<\/dt><dd[^>]*>15<\/dd>$/),
      expect.stringMatching(/^<dt[^>]*>Clientswhoreturn<\/dt><dd[^>]*>98%<\/dd>$/)
    ]);
    // The figure is a column flex stack, so `order: -1` on the value shows it above its label.
    expect(componentsCss()).toMatch(/\.so-foundation-stats-row__value\s*\{[^}]*order:\s*-1/);
    expect(componentsCss()).toMatch(/\.so-foundation-stats-row__figure\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/);
  });
});

describe('shell.footer', () => {
  const link = (label: string) => ({ id: label, label, link: { href: `/${label}/` } });
  /** Each rendered nav with the heading its aria-labelledby points at (looked up inside that nav only). */
  const navs = (out: string) =>
    [...out.matchAll(/<nav\b([^>]*)>([\s\S]*?)<\/nav>/g)].map(([, attrs, inner]) => {
      const ref = attrs.match(/aria-labelledby="([^"]+)"/)?.[1];
      return {
        label: attrs.match(/aria-label="([^"]+)"/)?.[1],
        heading: ref ? inner.match(new RegExp(`<h2\\b[^>]*id="${ref}"[^>]*>([^<]*)</h2>`))?.[1] : undefined,
        links: [...inner.matchAll(/<a\b[^>]*>([^<]*)<\/a>/g)].map((m) => m[1])
      };
    });

  it('renders a link group only while its list has links', () => {
    expect(navs(html('shell.footer', { links: [], contact: [link('email')] }))).toEqual([{ label: undefined, heading: 'Contact', links: ['email'] }]);
    expect(navs(html('shell.footer', { links: [link('about')], contact: [] }))).toEqual([{ label: undefined, heading: 'Explore', links: ['about'] }]);
    const neither = html('shell.footer', { links: [], contact: [] });
    expect(neither).not.toContain('<nav');
    expect(neither).not.toContain('<h2');
    expect(neither).toContain('© 2026 Studio');
  });

  it('labels each group by its own heading when both have links', () => {
    const out = html('shell.footer', { links: [link('about')], contact: [link('email')] });
    expect(navs(out)).toEqual([
      { label: undefined, heading: 'Explore', links: ['about'] },
      { label: undefined, heading: 'Contact', links: ['email'] }
    ]);
    const ids = [...out.matchAll(/aria-labelledby="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(2);
  });

  it.each([
    ['linksHeading', 0, 'Explore'],
    ['contactHeading', 1, 'Contact']
  ] as const)('keeps a group whose %s is cleared or blank, named by the heading default', (prop, index, fallback) => {
    for (const cleared of ['', '   ']) {
      const out = html('shell.footer', { links: [link('about')], contact: [link('email')], [prop]: cleared });
      const groups = navs(out);
      expect(groups).toHaveLength(2);
      expect(groups[index]).toEqual({ label: fallback, heading: undefined, links: [index ? 'email' : 'about'] });
      expect(groups[1 - index].heading).toBe(index ? 'Explore' : 'Contact');
      expect(groups[1 - index].label).toBeUndefined();
      expect(out).not.toMatch(EMPTY_HEADING);
      expect(tags(out, 'h2')).toHaveLength(1);
    }
  });
});

describe('optional headings', () => {
  const sections: Array<[ComponentId, string]> = [
    ['features.grid', 'h2'],
    ['team.grid', 'h2'],
    ['testimonials.grid', 'h2'],
    ['media.gallery', 'h2'],
    ['pricing.plans', 'h2'],
    ['faq.list', 'h2'],
    ['contact.details', 'h2'],
    ['hero.centered', 'h1'],
    ['hero.split', 'h1'],
    ['intro.page', 'h1'],
    ['content.media', 'h2'],
    ['cta.banner', 'h2']
  ];

  it.each(sections)('%s renders its heading when set and no empty heading when cleared', (componentId, tag) => {
    const text = `Heading of ${componentId}`;
    expect(tags(html(componentId, { heading: text }), tag)).toEqual([text]);
    for (const cleared of ['', '  ']) {
      const out = html(componentId, { heading: cleared });
      expect(out).not.toMatch(EMPTY_HEADING);
      expect(out).not.toMatch(new RegExp(`<${tag}\\b`));
    }
  });

  it.each(sections)('%s renders the heading level its placement chooses, with the same look', (componentId, tag) => {
    const text = `Heading of ${componentId}`;
    const classOf = (markup: string, level: string) => markup.match(new RegExp(`<${level}\\b[^>]*class="([^"]*)"`))?.[1];
    const usual = html(componentId, { heading: text });
    const other = tag === 'h1' ? 'h2' : 'h4';
    const chosen = html(componentId, { heading: text, headingLevel: other });
    expect(tags(chosen, other)).toEqual([text]);
    expect(chosen).not.toMatch(new RegExp(`<${tag}\\b`));
    expect(classOf(chosen, other)).toBe(classOf(usual, tag));
    expect(classOf(chosen, other)?.split(/\s+/)).toContain(nodeClass(componentId, 'heading'));
  });
});

describe('empty wrappers', () => {
  it('media.gallery leaves out its grid while it has no images (issue #60), and keeps it for one', () => {
    const grid = classed(nodeClass('media.gallery', 'grid'));
    const empty = html('media.gallery', {});
    expect(empty).not.toMatch(grid);
    expect(empty).not.toContain('<ul');
    expect(empty).toContain('>Recent projects<');
    // The same once the author has removed the last image.
    expect(html('media.gallery', { images: [] })).not.toMatch(grid);
    const one = html('media.gallery', { images: [{ id: 'a', image: { assetId: null, alt: '' }, caption: 'Kitchen' }] });
    expect(one).toMatch(grid);
    expect(one).toContain('>Kitchen</figcaption>');
  });

  it.each(['features.grid', 'team.grid', 'media.gallery'] as const)('%s keeps the heading group for any one of its texts and drops it when all are cleared', (componentId) => {
    const intro = classed(nodeClass(componentId, 'intro'));
    const none = { eyebrow: '', heading: '', lead: '' };
    for (const [field, value] of [['eyebrow', 'Eyebrow only'], ['heading', 'Heading only'], ['lead', 'Lead only']]) {
      const out = html(componentId, { ...none, [field]: value });
      expect(out).toMatch(intro);
      expect(out).toContain(`>${value}<`);
    }
    expect(html(componentId, none)).not.toMatch(intro);
    expect(html(componentId, { ...none, heading: '   ' })).not.toMatch(intro);
  });

  it('contact.details keeps its content column for the heading group or the action alone, and drops it when both are cleared', () => {
    const content = classed(nodeClass('contact.details', 'content'));
    const intro = classed(nodeClass('contact.details', 'intro'));
    const none = { eyebrow: '', heading: '', lead: '', actionLabel: '' };
    const actionOnly = html('contact.details', { ...none, actionLabel: 'Email us' });
    expect(actionOnly).toMatch(content);
    expect(actionOnly).not.toMatch(intro);
    expect(actionOnly).toContain('>Email us</a>');
    const leadOnly = html('contact.details', { ...none, lead: 'Write any time' });
    expect(leadOnly).toMatch(content);
    expect(leadOnly).toMatch(intro);
    expect(html('contact.details', none)).not.toMatch(content);
  });

  it.each(['hero.centered', 'hero.split'] as const)('%s drops its content column when every text and action is cleared', (componentId) => {
    const content = classed(nodeClass(componentId, 'content'));
    const none = { eyebrow: '', heading: '', lead: '', primaryLabel: '', secondaryLabel: '' };
    expect(html(componentId, { ...none, secondaryLabel: 'More' })).toMatch(content);
    expect(html(componentId, { ...none, lead: 'Only a lead' })).toMatch(content);
    expect(html(componentId, none)).not.toMatch(content);
  });
});

describe('empty action rows', () => {
  it.each(['hero.centered', 'hero.split', 'cta.banner'] as const)('%s renders the actions row for either label and leaves it out when both are cleared', (componentId) => {
    const actions = classed(nodeClass(componentId, 'actions'));
    const buttons = (out: string) => [...out.matchAll(/<(?:a|span)\b[^>]*class="[^"]*so-btn[^"]*"[^>]*>([^<]*)<\/(?:a|span)>/g)].map((m) => m[1]);
    // Resolved links, as the export passes them: a button shows only with a destination.
    const to = { href: '/contact/' };
    for (const [primaryLabel, secondaryLabel] of [['Go', ''], ['', 'More'], ['Go', 'More']]) {
      const out = html(componentId, { primaryLabel, secondaryLabel, primaryLink: to, secondaryLink: to });
      expect(out).toMatch(actions);
      expect(buttons(out)).toEqual([primaryLabel, secondaryLabel].filter(Boolean));
    }
    for (const blank of ['', '  ']) expect(html(componentId, { primaryLabel: blank, secondaryLabel: '', primaryLink: to, secondaryLink: to })).not.toMatch(actions);
    // A label with nowhere to go leaves no button for visitors.
    expect(buttons(html(componentId, { primaryLabel: 'Go', secondaryLabel: 'More', primaryLink: null, secondaryLink: null }))).toEqual([]);
    expect(buttons(html(componentId, { primaryLabel: 'Go', secondaryLabel: 'More', primaryLink: to, secondaryLink: null }))).toEqual(['Go']);
  });
});

describe('testimonials.grid', () => {
  it('renders client names in <cite> upright by default', () => {
    expect(tags(html('testimonials.grid'), 'cite')).toContain('Amelia Hart');
    const theme = bundle.files.get(`${STYLES_DIR}/theme.css`)!;
    expect(theme).toMatch(/(^|[\s,}])cite\s*\{\s*font-style:\s*normal;\s*\}/);
    // A plain element selector, so a node's own fontStyle (a class rule) still wins.
    expect(theme).not.toMatch(/cite[^{]*\{[^}]*!important/);
  });
});

describe('team.grid', () => {
  const member = /<li class="[^"]*so-foundation-team-grid__member[^"]*">([\s\S]*?)<\/li>/g;

  it('leaves out an empty role', () => {
    const out = html('team.grid', { people: [{ id: 'a', name: 'Hannah Wells', role: '', bio: '', portrait: { src: null, alt: '' } }] });
    expect(out).toContain('Hannah Wells');
    expect(out).not.toMatch(/<p\b[^>]*>\s*<\/p>/);
  });

  it('shows only the portraits people have, with no placeholder boxes, and no role an item leaves out', () => {
    bundle.state.assets.assets['as_hannah'] = { id: 'as_hannah', name: 'Hannah', file: 'static/media/hannah.jpg', mime: 'image/jpeg', bytes: 1, width: 400, height: 500, hash: 'h', kind: 'image', createdAt: '' } as never;
    const out = authoredHtml('team.grid', {
      people: [
        { id: 'a', name: 'Hannah Wells', role: 'Founder', bio: '', portrait: { assetId: 'as_hannah', alt: 'Hannah Wells smiling' } },
        { id: 'b', name: 'Marcus Lee', role: 'Project manager', bio: '', portrait: { assetId: 'as_missing', alt: 'Marcus' } },
        { id: 'c', name: 'Sofia Alvarez', bio: '' }
      ]
    });
    const people = [...out.matchAll(member)].map((m) => m[1].replace(/\s+/g, ' ').trim());
    expect(people).toHaveLength(3);
    expect(out).not.toContain('so-img--placeholder');
    expect(out.match(/<img\b/g)).toHaveLength(1);
    expect(people[0]).toMatch(/^<img\b[^>]*src="\/media\/hannah\.jpg"[^>]*alt="Hannah Wells smiling"[^>]*\/?> <h3\b[^>]*>Hannah Wells<\/h3> <p\b[^>]*>Founder<\/p>$/);
    expect(people[1]).toMatch(/^<h3\b[^>]*>Marcus Lee<\/h3> <p\b[^>]*>Project manager<\/p>$/);
    expect(people[2]).toMatch(/^<h3\b[^>]*>Sofia Alvarez<\/h3>$/);
  });
});

describe('logos.strip', () => {
  const logo = (name: string, image: Record<string, unknown> | null) => ({ id: name, name, logo: image ?? { src: null, alt: '' } });
  const items = (out: string) => [...out.matchAll(/<li class="[^"]*so-foundation-logos-strip__logo-item[^"]*">([\s\S]*?)<\/li>/g)].map((m) => m[1].trim());

  it('names every logo: its alt text, else the company name, and a decorative one by hidden text', () => {
    const out = html('logos.strip', {
      logos: [
        logo('Fernhill', { src: '/media/fernhill.png', alt: '' }),
        logo('Copperline', { src: '/media/copperline.png', alt: 'Copperline Café' }),
        logo('Marlow & Co', { src: '/media/marlow.png', alt: '', decorative: true }),
        logo('Bright Harbour', { src: '/media/harbour.png', alt: '   ' }),
        logo('Oakhurst', null)
      ]
    });
    const [fernhill, copperline, marlow, harbour, oakhurst] = items(out);
    expect(fernhill).toMatch(/^<img\b[^>]*alt="Fernhill"[^>]*\/?>$/);
    expect(copperline).toMatch(/^<img\b[^>]*alt="Copperline Café"[^>]*\/?>$/);
    expect(marlow).toMatch(/^<img\b[^>]*alt=""[^>]*\/?>\s*<span class="so-visually-hidden">Marlow &amp; Co<\/span>$/);
    expect(harbour).toMatch(/^<img\b[^>]*alt="Bright Harbour"[^>]*\/?>$/);
    expect(oakhurst).toMatch(/^<span\b[^>]*>Oakhurst<\/span>$/);
    expect(bundle.files.get(`${STYLES_DIR}/theme.css`)).toMatch(/\.so-visually-hidden\s*\{[^}]*position:\s*absolute[^}]*clip:/);
  });

  it('caps the height of tall or square logos without cropping them', () => {
    const rule = componentsCss().match(/\.so-foundation-logos-strip__logo-image\s*\{([^}]*)\}/)![1];
    expect(rule).toMatch(/max-height:\s*48px/);
    expect(rule).toMatch(/max-width:\s*140px/);
    expect(rule).toMatch(/width:\s*auto/);
    expect(rule).toMatch(/object-fit:\s*contain/);
  });
});

describe('shell.header', () => {
  const brand = (out: string) => out.match(/<a class="so-header__brand[^"]*"[^>]*>[\s\S]*?<\/a>/)![0].replace(/>\s+</g, '><');
  const logo = { src: '/media/logo.svg', alt: 'Studio wordmark' };

  it('announces the brand once when a logo sits beside the visible name', () => {
    for (const image of [logo, { ...logo, decorative: true }]) {
      const link = brand(html('shell.header', { siteName: 'Test Studio', logo: image, showSiteName: true }));
      expect(link).toMatch(/^<a\b[^>]*><img\b[^>]*alt=""[^>]*\/?><span>Test Studio<\/span><\/a>$/);
      expect(link).not.toMatch(/^<a\b[^>]*aria-label=/);
    }
  });

  it('names a logo shown alone by its own alt text, else by the site name', () => {
    const logoOnly = brand(html('shell.header', { siteName: 'Test Studio', logo, showSiteName: false }));
    expect(logoOnly).toMatch(/^<a\b[^>]*><img\b[^>]*alt="Studio wordmark"[^>]*\/?><\/a>$/);
    expect(logoOnly).not.toMatch(/^<a\b[^>]*aria-label=/);
    const decorative = brand(html('shell.header', { siteName: 'Test Studio', logo: { ...logo, decorative: true }, showSiteName: false }));
    expect(decorative).toMatch(/^<a\b[^>]*aria-label="Test Studio"[^>]*><img\b[^>]*alt=""/);
    const noAlt = brand(html('shell.header', { siteName: ' Test Studio ', logo: { src: '/media/logo.svg', alt: '' }, showSiteName: false }));
    expect(noAlt).toMatch(/^<a\b[^>]*aria-label="Test Studio"/);
    const blankName = brand(html('shell.header', { siteName: '  ', logo, showSiteName: true }));
    expect(blankName).toMatch(/^<a\b[^>]*><img\b[^>]*alt="Studio wordmark"[^>]*\/?><\/a>$/);
  });

  it('asks for a logo only as wide as its small slot, so a photo logo loads a small copy (#170)', () => {
    const photo = (width?: number, height?: number) => ({ src: '/assets/dining.jpg', alt: 'Dining room', width, height, srcset: '/assets/dining-160w.jpg 160w, /assets/dining-480w.jpg 480w, /assets/dining.jpg 1536w' });
    const sizes = (image: Record<string, unknown>) => brand(html('shell.header', { siteName: 'Test Studio', logo: image, showSiteName: false })).match(/<img\b[^>]*\bsizes="([^"]*)"/)?.[1];
    // 34px tall: a 3:2 photo shows 51px wide.
    expect(sizes(photo(1536, 1024))).toBe('51px');
    // A long wordmark stops at the slot's 160px, and so does a logo whose dimensions are unknown; a tall one is narrow.
    expect(sizes(photo(2400, 200))).toBe('160px');
    expect(sizes(photo())).toBe('160px');
    expect(sizes(photo(500, 1000))).toBe('17px');
    // Rounded up, never down: 34 × 10/7 is 48.6.
    expect(sizes(photo(1000, 700))).toBe('49px');
    // The slot itself holds the logo to that width, letterboxed rather than cropped.
    const rule = bundle.defs['shell.header'].source!.match(/\.so-header__brand :global\(\.so-header__logo\)\s*\{([^}]*)\}/)![1];
    expect(rule).toMatch(/max-width:\s*160px/);
    expect(rule).toMatch(/height:\s*34px/);
    expect(rule).toMatch(/object-fit:\s*contain/);
  });

  describe('notice', () => {
    const contactId = () => Object.values(bundle.state.pages).find((p) => p.route === '/contact/')!.id;
    /** The notice bar's markup, without Svelte's scoping classes or the whitespace between tags. */
    const notice = (out: string) =>
      out.match(/<div class="so-header__notice[^"]*"[^>]*>[\s\S]*?<\/div>/)?.[0].replace(/ class="svelte-[a-z0-9]+"/g, '').replace(/ svelte-[a-z0-9]+/g, '').replace(/\s+/g, ' ').replace(/> </g, '><') ?? null;
    const closed = 'Studio closed on Friday for repairs';

    it('shows nothing above the header until it has words', () => {
      const out = authoredHtml('shell.header', { siteName: 'Test Studio' });
      expect(out).not.toContain('so-header__notice');
      for (const blank of ['', '   ']) expect(notice(authoredHtml('shell.header', { notice: blank }))).toBeNull();
      // Values the editor never stores still render no bar (and no error).
      for (const odd of [null, 42, { text: 'Closed' }]) expect(notice(html('shell.header', { notice: odd }))).toBeNull();
    });

    it('shows its words in a bar above the brand row, leaving the name, menu and action as they were', () => {
      const menu = [{ id: 'l1', label: 'Contact us', link: { type: 'page', target: contactId() } }];
      const props = { siteName: 'Test Studio', links: menu, notice: `  ${closed}  `, ctaLabel: 'Book a call', ctaLink: { type: 'page', target: contactId() } };
      const out = authoredHtml('shell.header', props);
      expect(notice(out)).toBe(`<div class="so-header__notice"><p class="so-header__notice-inner"><span>${closed}</span></p></div>`);
      // The bar sits inside the header, before the row holding the brand, the menu button and the menu.
      expect(out.indexOf('so-header__notice')).toBeGreaterThan(out.indexOf('<header'));
      expect(out.indexOf('so-header__notice')).toBeLessThan(out.indexOf('so-header__inner'));
      const without = authoredHtml('shell.header', { ...props, notice: '' });
      const rest = (markup: string) => markup.slice(markup.indexOf('<div class="so-header__inner'));
      expect(rest(out)).toBe(rest(without));
      expect(rest(out)).toMatch(/<span>Test Studio<\/span>/);
      expect(rest(out)).toMatch(/<a href="\/contact\/"[^>]*>Contact us<\/a>/);
      expect(rest(out)).toMatch(/<a class="so-btn so-btn--primary so-header__cta[^"]*" href="\/contact\/"[^>]*>Book a call<\/a>/);
    });

    it('links its label once the label has words and somewhere to go, and goes with its words', () => {
      const link = { type: 'page', target: contactId() };
      expect(notice(authoredHtml('shell.header', { notice: closed, noticeLabel: 'Opening hours', noticeLink: link }))).toBe(
        `<div class="so-header__notice"><p class="so-header__notice-inner"><span>${closed}</span><a href="/contact/">Opening hours</a></p></div>`
      );
      expect(notice(authoredHtml('shell.header', { notice: closed, noticeLabel: 'Opening hours', noticeLink: { type: 'none', target: '' } }))).not.toContain('<a');
      expect(notice(authoredHtml('shell.header', { notice: closed, noticeLabel: '  ', noticeLink: link }))).not.toContain('<a');
      expect(notice(authoredHtml('shell.header', { notice: closed, noticeLink: link }))).not.toContain('<a');
      expect(notice(authoredHtml('shell.header', { notice: closed, noticeLabel: ' Opening hours ', noticeLink: link }))).toContain('<a href="/contact/">Opening hours</a>');
      // Clearing the words removes the notice, link and all.
      for (const blank of ['', '  ']) expect(notice(authoredHtml('shell.header', { notice: blank, noticeLabel: 'Opening hours', noticeLink: link }))).toBeNull();
      const away = notice(authoredHtml('shell.header', { notice: closed, noticeLabel: 'Map', noticeLink: { type: 'url', target: 'https://maps.example.com/studio', newTab: true } }));
      expect(away).toMatch(/<a href="https:\/\/maps\.example\.com\/studio" target="_blank" rel="noopener noreferrer">Map<\/a>/);
    });

    it('stays readable: brand over the page colour over white, as the contrast check measures it, and a focus ring in its text colour', () => {
      const source = bundle.defs['shell.header'].source!;
      const rule = (selector: string) => source.match(new RegExp(`\\n\\t${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? '';
      // The theme's contrast check measures Text on brand against Brand painted over the page colour.
      expect(rule('.so-header__notice')).toMatch(
        /background:\s*linear-gradient\(var\(--so-color-brand\), var\(--so-color-brand\)\), linear-gradient\(var\(--so-color-background\), var\(--so-color-background\)\) #fff;/
      );
      expect(rule('.so-header__notice')).toMatch(/color:\s*var\(--so-color-on-brand\)/);
      expect(rule('.so-header__notice a:focus-visible')).toMatch(/outline-color:\s*currentColor/);
      // Nothing in the band scrolls on its own (a scrolling box needs a tab stop and can hold the page still).
      expect(rule('.so-header__notice-inner')).toMatch(/text-align:\s*center/);
      expect(rule('.so-header__notice-inner')).not.toMatch(/overflow(-[xy])?\s*:|max-height/);
      expect(bundle.defs['shell.header'].properties.notice).toMatchObject({ type: 'string', maxLength: 160 });
    });

    it('scrolls away with the page while the brand row and its menu stay pinned, however tall it is', () => {
      const source = bundle.defs['shell.header'].source!;
      // The header measures the notice and pins itself that far above the window's top edge.
      expect(source).toMatch(/el\.style\.setProperty\('--so-header-notice', noticeHeight\)/);
      expect(source).toMatch(/\.so-header--sticky \{\s*position: sticky;[^}]*top: calc\(-1 \* var\(--so-header-notice, 0px\)\);/);
      // The phone menu has the room below the brand row, not below the notice too.
      expect(source).toMatch(/max-height: calc\(100dvh - 100% \+ var\(--so-header-notice, 0px\)\);/);
      // Its measure goes with the effect that set it.
      expect(source).toMatch(/el\.style\.removeProperty\('--so-header-notice'\);\n\t\t\};/);
    });
  });

  describe('submenus (#169)', () => {
    const pageAt = (route: string) => Object.values(bundle.state.pages).find((p) => p.route === route)!.id;
    const link = (route: string) => ({ type: 'page', target: pageAt(route) });
    /** The main menu's markup, without Svelte's scoping classes or the whitespace between tags. */
    const nav = (out: string) =>
      out.match(/<ul class="so-header__list[^"]*"[^>]*>[\s\S]*<\/ul>(?=\s*(<a class="so-btn|<\/nav>))/)![0].replace(/ class="svelte-[a-z0-9]+"/g, '').replace(/ svelte-[a-z0-9]+/g, '').replace(/\s+/g, ' ').replace(/> </g, '><');
    const toggle = (id: string, label: string) =>
      `<button type="button" class="so-header__sub-toggle" aria-expanded="false" aria-controls="so-sub:${id}"><span class="so-visually-hidden">${label} submenu</span><svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l4 4 4-4"></path></svg></button>`;

    it('nests links marked to show under the link above in a hidden list its button controls', () => {
      const links = [
        { id: 'l1', label: 'Home', link: link('/') },
        { id: 'l2', label: 'About', link: link('/about/') },
        { id: 'l3', label: 'Team', link: { type: 'url', target: 'https://example.com/team' }, sub: true },
        { id: 'l4', label: 'Contact', link: link('/contact/'), sub: true },
        { id: 'l5', label: 'Shop', link: { type: 'url', target: 'https://example.com/shop' } }
      ];
      expect(nav(authoredHtml('shell.header', { links }))).toBe(
        '<ul class="so-header__list">' +
          '<li><a href="/" aria-current="page">Home</a></li>' +
          `<li class="so-header__group"><a href="/about/">About</a>${toggle('1', 'About')}` +
          '<ul id="so-sub:1" class="so-header__sub" hidden=""><li><a href="https://example.com/team">Team</a></li><li><a href="/contact/">Contact</a></li></ul></li>' +
          '<li><a href="https://example.com/shop">Shop</a></li>' +
          '</ul>'
      );
    });

    it('keeps a flat menu flat, and a marked link with no link above it at the top level', () => {
      const flat = nav(authoredHtml('shell.header', { links: [{ id: 'l1', label: 'About', link: link('/about/') }, { id: 'l2', label: 'Contact', link: link('/contact/'), sub: false }] }));
      expect(flat).toBe('<ul class="so-header__list"><li><a href="/about/">About</a></li><li><a href="/contact/">Contact</a></li></ul>');
      const leading = nav(authoredHtml('shell.header', { links: [{ id: 'l1', label: 'About', link: link('/about/'), sub: true }, { id: 'l2', label: 'Contact', link: link('/contact/'), sub: true }] }));
      expect(leading).toBe(`<ul class="so-header__list"><li class="so-header__group"><a href="/about/">About</a>${toggle('0', 'About')}<ul id="so-sub:0" class="so-header__sub" hidden=""><li><a href="/contact/">Contact</a></li></ul></li></ul>`);
      // Items stored before submenus existed have no mark: they are top-level links.
      expect(nav(authoredHtml('shell.header', { links: [{ id: 'l1', label: 'About', link: link('/about/') }] }))).toBe('<ul class="so-header__list"><li><a href="/about/">About</a></li></ul>');
    });

    it('names each submenu by its place in the menu, whatever its link’s item ID holds', () => {
      const links = [
        { id: 'a b', label: 'About', link: link('/about/') },
        { id: 'l2', label: 'Contact', link: link('/contact/'), sub: true },
        { id: 'a-b', label: 'Shop', link: { type: 'url', target: 'https://example.com/shop' } },
        { id: 'x"y', label: 'Team', link: { type: 'url', target: 'https://example.com/team' }, sub: true }
      ];
      const out = nav(authoredHtml('shell.header', { links }));
      expect([...out.matchAll(/aria-controls="([^"]*)"/g)].map((m) => m[1])).toEqual(['so-sub:0', 'so-sub:1']);
      expect([...out.matchAll(/<ul id="([^"]*)" class="so-header__sub"/g)].map((m) => m[1])).toEqual(['so-sub:0', 'so-sub:1']);
    });

    it('marks only the open page, and its parent link as the section, on a page under it', () => {
      const links = [
        { id: 'l1', label: 'About', link: link('/about/') },
        { id: 'l2', label: 'Contact', link: link('/contact/'), sub: true }
      ];
      // The page being rendered is the one at /contact/.
      (globalThis as { soTestRouteId?: string }).soTestRouteId = '/contact';
      let out: string;
      try {
        out = nav(authoredHtml('shell.header', { links }, pageAt('/contact/')));
      } finally {
        delete (globalThis as { soTestRouteId?: string }).soTestRouteId;
      }
      expect(out).toContain('<a href="/contact/" aria-current="page">Contact</a>');
      expect(out).toContain('<li class="so-header__group so-header__group--current"><a href="/about/">About</a>');
      expect(out.match(/aria-current/g)).toHaveLength(1);
    });

    it('declares the field, and styles the panel and the phone menu without hover', () => {
      const field = bundle.defs['shell.header'].properties.links;
      expect(field.type === 'list' && field.fields.sub).toMatchObject({ type: 'boolean', default: false, label: 'Show under the link above' });
      const source = bundle.defs['shell.header'].source!;
      expect(source).toMatch(/\.so-header__sub\[hidden\] \{\s*display: none;/);
      expect(source).not.toMatch(/:hover[^{]*\.so-header__sub\b[^{]*\{[^}]*display/);
      // Escape closes the submenu first, back to its button, then the phone menu.
      expect(source).toMatch(/if \(openSub !== null\) \{[\s\S]*?subToggle\(id\)\?\.focus\(\);[\s\S]*?\} else if \(menu\?\.open\) \{/);
    });
  });

  it('shows a text-only brand as is, and names an empty one Home', () => {
    const textOnly = brand(html('shell.header', { siteName: 'Test Studio', logo: null }));
    expect(textOnly).toMatch(/^<a\b[^>]*><span>Test Studio<\/span><\/a>$/);
    expect(textOnly).not.toMatch(/^<a\b[^>]*aria-label=/);
    for (const siteName of ['', '   ', null]) {
      const empty = brand(html('shell.header', { siteName, logo: { src: null, alt: 'Old logo' } }));
      expect(empty).toMatch(/^<a\b[^>]*aria-label="Home"/);
      expect(empty).not.toContain('<span');
    }
  });
});

describe('content.pages', () => {
  it('links every card to its page, named by the page title unless the card has its own, and leaves out a card whose page has gone', () => {
    const s = bundle.state;
    s.assets.assets.a_kitchen = { id: 'a_kitchen', name: 'kitchen.jpg', file: 'static/assets/kitchen.jpg', mime: 'image/jpeg', bytes: 1, width: 1200, height: 800, hash: 'x', kind: 'image', altSuggestion: 'An oak kitchen', createdAt: '' };
    s.pages.pg_kitchens = { ...structuredClone(s.pages[s.site.homePageId]), id: 'pg_kitchens', title: 'Kitchen renovations', route: '/projects/kitchens/', seo: { description: 'Three kitchens.', socialImage: 'a_kitchen' }, rootIds: [], nodes: {} };
    s.pages.pg_gardens = { ...structuredClone(s.pages[s.site.homePageId]), id: 'pg_gardens', title: 'Gardens', route: '/work/gardens/', seo: {}, rootIds: [], nodes: {} };
    const out = authoredHtml('content.pages', {
      heading: 'Projects',
      items: [
        { id: 'i_1', pageLink: { type: 'page', target: 'pg_kitchens' }, title: '', description: '' },
        { id: 'i_2', pageLink: { type: 'page', target: 'pg_gardens' }, title: 'Garden rooms', description: 'Our own words.' },
        { id: 'i_3', pageLink: { type: 'page', target: 'pg_gone' }, title: 'Old project', description: 'Gone.' },
        // Outside the site and with no title of its own: nothing to click, so no card.
        { id: 'i_4', pageLink: { type: 'url', target: 'https://partner.example/' }, title: '', description: 'A partner with no name.' },
        { id: 'i_5', pageLink: { type: 'url', target: 'https://partner.example/' }, title: 'Our partner', description: '' }
      ]
    });
    const links = [...out.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[1], m[2]]);
    expect(links).toEqual([
      ['/projects/kitchens/', 'Kitchen renovations'],
      ['/work/gardens/', 'Garden rooms'],
      ['https://partner.example/', 'Our partner']
    ]);
    expect(tags(out, 'li')).toHaveLength(3);
    expect(out).not.toContain('A partner with no name.');
    // The page's sharing image shows on its card, described by the library's suggestion; the others have none.
    expect([...out.matchAll(/<img\b[^>]*>/g)].map((m) => [/src="([^"]+)"/.exec(m[0])?.[1], /alt="([^"]*)"/.exec(m[0])?.[1]])).toEqual([['/assets/kitchen.jpg', 'An oak kitchen']]);
    expect(out).toContain('>Three kitchens.<');
    expect(out).toContain('>Our own words.<');
    expect(out).not.toContain('Old project');
    expect(out).not.toMatch(EMPTY_HEADING);
    // With no pages chosen yet the section is its heading alone: no empty list.
    expect(authoredHtml('content.pages', { heading: 'Projects', items: [] })).not.toContain('<ul');
  });
});

describe('dated articles', () => {
  /** Two announcements, the later one added first, on a site written in British English. */
  function announcements() {
    const s = bundle.state;
    s.site.language = 'en-GB';
    const base = structuredClone(s.pages[s.site.homePageId]);
    s.pages.pg_spring = { ...base, id: 'pg_spring', title: 'Spring makers announced', route: '/news/spring-makers/', seo: {}, rootIds: [], nodes: {}, article: { date: '2027-03-02', byline: 'Market team', excerpt: 'Twenty new stallholders.' } };
    s.pages.pg_winter = { ...structuredClone(base), id: 'pg_winter', title: 'Winter opening hours', route: '/news/winter-hours/', seo: {}, rootIds: [], nodes: {}, article: { date: '2026-11-14' } };
    return s;
  }
  const cards = (out: string) =>
    tags(out, 'article').map((card) => {
      const a = /<a\b[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/.exec(card);
      const t = /<time datetime="([^"]+)">([^<]*)<\/time>/.exec(card);
      return [a?.[1], a?.[2], t?.[1], t?.[2]];
    });

  it('renders the News list newest first, each card a link to its article with a machine-readable date', () => {
    const s = announcements();
    try {
      const out = authoredHtml('content.news', { heading: 'Market news' }, s.site.homePageId);
      expect(cards(out)).toEqual([
        ['/news/spring-makers/', 'Spring makers announced', '2027-03-02', '2 March 2027'],
        ['/news/winter-hours/', 'Winter opening hours', '2026-11-14', '14 November 2026']
      ]);
      expect(out).toContain('>Market team<');
      expect(out).toContain('>Twenty new stallholders.<');
      expect(out).not.toMatch(EMPTY_HEADING);
      expect(out).not.toContain('data-so-');
      // Winter has no byline: its card shows no empty one.
      expect(out).not.toMatch(/<span\b[^>]*>\s*<\/span>/);
      // Redated, the winter notice moves to the top, with its new date.
      s.pages.pg_winter.article = { date: '2027-04-01' };
      expect(cards(authoredHtml('content.news', {}, s.site.homePageId))).toEqual([
        ['/news/winter-hours/', 'Winter opening hours', '2027-04-01', '1 April 2027'],
        ['/news/spring-makers/', 'Spring makers announced', '2027-03-02', '2 March 2027']
      ]);
    } finally {
      delete s.pages.pg_spring;
      delete s.pages.pg_winter;
      s.site.language = 'en';
    }
  });

  it('renders the generated Home route newest first, and again after a redating, with each date as a time element', async () => {
    let s = createStarterState('business', 'Riverside Market', false);
    s.site.language = 'en-GB';
    s = applyOperations(s, [
      { type: 'page.create', pageId: 'pg_spring', title: 'Spring makers announced', route: '/news/spring-makers/', starter: 'article', articleDate: '2027-03-02' },
      { type: 'page.create', pageId: 'pg_winter', title: 'Winter opening hours', route: '/news/winter-hours/', starter: 'article', articleDate: '2026-11-14' },
      { type: 'node.insert', owner: { kind: 'page', id: s.site.homePageId }, componentId: 'content.news', props: { heading: 'Market news' } }
    ]).state;
    expect(cards(await renderRoute(s, s.site.homePageId))).toEqual([
      ['/news/spring-makers/', 'Spring makers announced', '2027-03-02', '2 March 2027'],
      ['/news/winter-hours/', 'Winter opening hours', '2026-11-14', '14 November 2026']
    ]);
    const later = applyOperations(s, [{ type: 'page.update', pageId: 'pg_winter', articleDate: '2027-04-01' }]).state;
    expect(cards(await renderRoute(later, later.site.homePageId))).toEqual([
      ['/news/winter-hours/', 'Winter opening hours', '2027-04-01', '1 April 2027'],
      ['/news/spring-makers/', 'Spring makers announced', '2027-03-02', '2 March 2027']
    ]);
    // The article's own route shows its title as its Heading 1 and its date.
    const page = await renderRoute(later, 'pg_winter');
    expect(tags(page, 'h1')).toEqual(['Winter opening hours']);
    expect(page).toContain('<time datetime="2027-04-01">1 April 2027</time>');
  }, 60_000);

  it('leaves no empty list behind before there are any articles', () => {
    const out = authoredHtml('content.news', { heading: 'Market news' }, bundle.state.site.homePageId);
    expect(out).not.toContain('<ul');
    expect(out).toContain('>Market news<');
  });

  it('renders the Article header with the page title as its Heading 1, its date, byline and excerpt', () => {
    const s = announcements();
    try {
      const out = authoredHtml('content.article', {}, 'pg_spring');
      expect(tags(out, 'h1')).toEqual(['Spring makers announced']);
      expect(out).toContain('<time datetime="2027-03-02">2 March 2027</time>');
      // Title, then date and byline, then the excerpt.
      const at = (text: string) => out.indexOf(text);
      expect(at('Spring makers announced')).toBeLessThan(at('2 March 2027'));
      expect(at('2 March 2027')).toBeLessThan(at('Market team'));
      expect(at('Market team')).toBeLessThan(at('Twenty new stallholders.'));
      expect(out).toContain('>Market team<');
      expect(out).toContain('>Twenty new stallholders.<');
      // An article with no byline or excerpt shows neither, nor an empty paragraph for them.
      const winter = authoredHtml('content.article', {}, 'pg_winter');
      expect(winter).toContain('<time datetime="2026-11-14">14 November 2026</time>');
      expect(winter).not.toMatch(/<p\b[^>]*>\s*<\/p>/);
      expect(winter).not.toMatch(/<span\b[^>]*>\s*<\/span>/);
      // On an ordinary page it is the title alone; with no page (a shared part) it shows nothing of a page.
      const plain = authoredHtml('content.article', {}, s.site.homePageId);
      expect(tags(plain, 'h1')).toEqual([s.pages[s.site.homePageId].title]);
      expect(plain).not.toContain('<time');
      expect(plain).not.toMatch(/<p\b[^>]*>\s*<\/p>/);
      expect(authoredHtml('content.article', {})).not.toContain('<h1');
    } finally {
      delete s.pages.pg_spring;
      delete s.pages.pg_winter;
      s.site.language = 'en';
    }
  });
});

describe('data.table', () => {
  const table = {
    columns: [
      { id: 'col_day', label: 'Day' },
      { id: 'col_workshop', label: 'Workshop' },
      { id: 'col_time', label: 'Start time' }
    ],
    rows: [
      { id: 'row_1', cells: { col_day: 'Monday', col_workshop: 'Wheel throwing', col_time: '10:00' } },
      { id: 'row_2', cells: { col_day: 'Wednesday', col_workshop: 'Hand building', col_time: '18:30' } },
      { id: 'row_4', cells: { col_day: 'Friday', col_workshop: 'Raku', col_time: '17:00' } }
    ]
  };
  /** Markup without Svelte's scoped-style classes, which say nothing about the structure. */
  const bare = (out: string) => out.replace(/ class="svelte-[a-z0-9]+"/g, '').replace(/ svelte-[a-z0-9]+(?=")/g, '');
  const rendered = (props: Record<string, unknown>) => bare(authoredHtml('data.table', props));
  const rowsOf = (out: string) => tags(tags(out, 'tbody')[0], 'tr').map((tr) => [...tr.matchAll(/<(th|td)\b([^>]*)>([^<]*)<\/\1>/g)].map((m) => `${m[1]}${m[2]}:${m[3]}`));

  it('puts every column name in a header cell over its cells, in column order (issue #179)', () => {
    const out = rendered({ table, caption: 'Weekly workshops' });
    expect(tags(tags(out, 'thead')[0], 'th')).toEqual(['Day', 'Workshop', 'Start time']);
    expect(out.match(/<th scope="col">/g)).toHaveLength(3);
    expect(rowsOf(out)).toEqual([
      ['td:Monday', 'td:Wheel throwing', 'td:10:00'],
      ['td:Wednesday', 'td:Hand building', 'td:18:30'],
      ['td:Friday', 'td:Raku', 'td:17:00']
    ]);
    // A moved column moves its cells with it.
    const moved = rendered({ table: { ...table, columns: [table.columns[2], table.columns[0], table.columns[1]] } });
    expect(rowsOf(moved)).toEqual([
      ['td:10:00', 'td:Monday', 'td:Wheel throwing'],
      ['td:18:30', 'td:Wednesday', 'td:Hand building'],
      ['td:17:00', 'td:Friday', 'td:Raku']
    ]);
  });

  it('names each row by its first cell when row headings are on', () => {
    const out = rendered({ table, rowHeaders: true });
    expect(rowsOf(out).map((r) => r[0])).toEqual(['th scope="row":Monday', 'th scope="row":Wednesday', 'th scope="row":Friday']);
    expect(rowsOf(out).map((r) => r.slice(1))).toEqual([
      ['td:Wheel throwing', 'td:10:00'],
      ['td:Hand building', 'td:18:30'],
      ['td:Raku', 'td:17:00']
    ]);
  });

  it('scrolls inside a focusable region named by the caption, or by the heading without one', () => {
    const out = rendered({ table, caption: 'Weekly workshops', heading: 'Timetable' });
    const region = out.match(/<div class="[^"]*so-table__scroll[^"]*"([^>]*)>/)![1];
    expect(region).toContain('role="region"');
    expect(region).toContain('tabindex="0"');
    const ref = region.match(/aria-labelledby="([^"]+)"/)![1];
    expect(out).toMatch(new RegExp(`<caption id="${ref}">Weekly workshops</caption>`));
    const uncaptioned = rendered({ table, caption: '', heading: 'Timetable' });
    expect(uncaptioned).not.toContain('<caption');
    expect(uncaptioned.match(/<div class="[^"]*so-table__scroll[^"]*"([^>]*)>/)![1]).toContain('aria-label="Timetable"');
    const blank = rendered({ table, caption: '   ', heading: 'Timetable' });
    expect(blank).not.toContain('<caption');
    expect(blank.match(/<div class="[^"]*so-table__scroll[^"]*"([^>]*)>/)![1]).toContain('aria-label="Timetable"');
    const spaces = rendered({ table, caption: '', heading: '   ' });
    expect(spaces).not.toMatch(EMPTY_HEADING);
    expect(spaces.match(/<div class="[^"]*so-table__scroll[^"]*"([^>]*)>/)![1]).toContain('aria-label="Table"');
    const nameless = rendered({ table, caption: '', heading: '' });
    expect(nameless.match(/<div class="[^"]*so-table__scroll[^"]*"([^>]*)>/)![1]).toContain('aria-label="Table"');
    expect(nameless).not.toMatch(EMPTY_HEADING);
  });

  it('keeps the page from scrolling sideways: only the table region scrolls', () => {
    const source = bundle.files.get(defFile(bundle.defs['data.table']))!;
    expect(source).toMatch(/\.so-table__scroll\s*\{[^}]*max-width:\s*100%[^}]*overflow-x:\s*auto/);
    expect(source).toMatch(/\.so-table__inner\s*\{[^}]*min-width:\s*0/);
    // In a row or grid the section itself may shrink, so its content never widens the page.
    expect(source).toMatch(/\.so-table\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%/);
    expect(source).not.toMatch(/overflow-x:\s*(visible|hidden)/);
  });

  it('shows text as text, and a hand-edited odd table without failing', () => {
    const odd = rendered({ table: { columns: [{ id: 'col_a', label: '<b>A & {B}</b>' }], rows: [{ id: 'row_1', cells: { col_a: '1 < 2 & {x}' } }] } });
    expect(odd).toContain('<th scope="col">&lt;b>A &amp; {B}&lt;/b></th>');
    expect(odd).toContain('<td>1 &lt; 2 &amp; {x}</td>');
    const damaged = bare(html('data.table', { table: { columns: [null, { id: 'col_a', label: 'A' }], rows: [{ id: 'row_1', cells: null }, null, { id: 'row_2', cells: { col_a: 'kept' } }] } }));
    expect(tags(tags(damaged, 'thead')[0], 'th')).toEqual(['A']);
    expect(rowsOf(damaged)).toEqual([['td:'], ['td:kept']]);
    // A label or cell that is not text renders empty instead of failing the page.
    const odder = bare(html('data.table', { table: { columns: [{ id: 'col_a', label: { toString: null } }], rows: [{ id: 'row_1', cells: { col_a: { toString: null } } }] } }));
    expect(rowsOf(odder)).toEqual([['td:']]);
    expect(() => html('data.table', { table: null })).not.toThrow();
  });
});

describe('media.video (issue #73)', () => {
  const bare = (out: string) => out.replace(/ class="svelte-[a-z0-9]+"/g, '').replace(/ svelte-[a-z0-9]+(?=")/g, '');
  const rendered = (props: Record<string, unknown>) => bare(authoredHtml('media.video', props));
  const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

  it('shows a Play button naming the video and the host it loads from, and loads nothing from the host until it is pressed', () => {
    const out = rendered({ heading: 'Take a tour', title: 'Tour of our studio', url: YT });
    expect(tags(out, 'h2')).toEqual(['Take a tour']);
    const [button] = tags(out, 'button');
    expect(button).toContain('Play video');
    expect(button).toContain('Tour of our studio');
    expect(button).toContain('Loads the player from YouTube');
    expect(out).toMatch(/<button type="button" class="so-video__play"/);
    // No player, thumbnail or anything else from the host before the visitor asks for it.
    expect(out).not.toMatch(/<iframe|youtube\.com|youtube-nocookie|ytimg|vimeo\.com/);
    expect(rendered({ title: 'Kiln firing', url: 'https://vimeo.com/76979871' })).toContain('Loads the player from Vimeo');
  });

  it('names a video without a title by its host, so the button is never unnamed', () => {
    expect(tags(rendered({ title: '   ', url: YT }), 'button')[0]).toContain('Video from YouTube');
  });

  it('shows no player for an empty or unsupported address, and no editor note on the exported page', () => {
    for (const url of ['', 'https://example.com/tour.mp4', 'javascript:alert(1)']) {
      const out = rendered({ heading: 'Take a tour', title: 'Tour', url });
      expect(tags(out, 'h2')).toEqual(['Take a tour']);
      expect(out).not.toMatch(/<button|<iframe|so-video__|data-so-/);
    }
  });

  it('shows text as text', () => {
    const out = rendered({ heading: '<b>Tour</b> & {x}', title: '<img src=x onerror=alert(1)>', url: YT });
    expect(out).toContain('&lt;b>Tour&lt;/b> &amp; {x}');
    expect(out).toContain('&lt;img src=x onerror=alert(1)>');
    expect(out).not.toContain('<img');
  });

  it('keeps a 16:9 frame as wide as its column', () => {
    const helper = bundle.files.get('src/lib/siteorigin/runtime/VideoPlayer.svelte')!;
    expect(helper).toMatch(/aspect-ratio: 16 \/ 9/);
    expect(helper).toMatch(/\.so-video \{[^}]*width: 100%/);
  });
});

describe('media.carousel (issue #381)', () => {
  const bare = (out: string) => out.replace(/ class="svelte-[a-z0-9]+"/g, '').replace(/ svelte-[a-z0-9]+(?=")/g, '');
  const slide = (id: string, caption: string, link = { type: 'none', target: '' }, alt = '') => ({ id, image: { assetId: null as string | null, alt, decorative: false }, caption, link });
  const SLIDES = [slide('a', 'Measuring the room'), slide('b', 'Choosing the finishes', { type: 'url', target: 'https://example.com/finishes' }), slide('c', '')];
  const rendered = (props: Record<string, unknown>) => bare(authoredHtml('media.carousel', props));
  const list = (out: string) => out.match(/<ul\b([^>]*)>([\s\S]*)<\/ul>/);

  it('renders every slide as an item of one list that scrolls, named by the heading and reachable by keyboard', () => {
    const out = rendered({ heading: 'Kitchens we have built', slides: SLIDES });
    expect(out.match(/<ul\b/g)).toHaveLength(1);
    const [, attrs, inner] = list(out)!;
    expect(attrs).toMatch(classed('so-carousel__list'));
    expect(attrs).toMatch(classed(nodeClass('media.carousel', 'track')));
    expect(attrs).toContain('aria-label="Kitchens we have built"');
    expect(attrs).toContain('tabindex="0"');
    // Each slide is a list item holding a figure: its image, and its caption while it has one.
    expect(inner.match(/<li\b/g)).toHaveLength(3);
    expect(tags(inner, 'figcaption')).toEqual(['Measuring the room', 'Choosing the finishes']);
    expect(inner.match(/<img\b/g) ?? inner.match(/so-img--placeholder/g)).toHaveLength(3);
  });

  it('makes a slide with a destination one link around its picture and caption, and leaves the others plain', () => {
    const out = rendered({ slides: SLIDES });
    const items = tags(list(out)![2], 'li');
    expect(items[1]).toMatch(/^\s*<a\b[^>]*href="https:\/\/example\.com\/finishes"[^>]*>\s*<figure\b[\s\S]*<\/figure>\s*<\/a>\s*$/);
    for (const i of [0, 2]) {
      expect(items[i]).not.toContain('<a');
      expect(items[i]).toMatch(/^\s*<div\b[^>]*>\s*<figure\b/);
    }
  });

  it('names a linked slide with no caption and a decorative or missing picture, so its link is never empty', () => {
    const named = (s: ReturnType<typeof slide>) => tags(tags(list(rendered({ slides: [s] }))![2], 'li')[0], 'a')[0];
    const away = { type: 'url', target: 'https://example.com/a' };
    bundle.state.assets.assets['as_room'] = { id: 'as_room', name: 'Room', file: 'static/media/room.jpg', mime: 'image/jpeg', bytes: 1, width: 800, height: 600, hash: 'r', kind: 'image', createdAt: '' } as never;
    const decorative = { ...slide('d', '', away), image: { assetId: 'as_room', alt: '', decorative: true } };
    // No picture chosen: the placeholder is named.
    expect(named(slide('p', '', away))).toMatch(/role="img" aria-label="Slide"/);
    // A decorative picture keeps its empty description and says it as hidden text, chosen or not.
    expect(named(decorative)).toMatch(/<img\b[^>]*alt=""[\s\S]*<span class="so-visually-hidden">Slide<\/span>/);
    const decorativeMissing = { ...slide('m', '', away), image: { assetId: null, alt: '', decorative: true } };
    expect(named(decorativeMissing)).toMatch(/aria-hidden="true"[\s\S]*<span class="so-visually-hidden">Slide<\/span>/);
    // Its own description and its caption name it otherwise.
    expect(named(slide('c', 'Kitchen', away))).toContain('Kitchen</figcaption>');
    expect(named(slide('a', '', away, 'A calm kitchen'))).toContain('aria-label="A calm kitchen"');
  });

  it('has no buttons or count until the page’s script runs, and nothing at all without slides', () => {
    const out = rendered({ slides: SLIDES });
    expect(out).not.toMatch(/<button|so-carousel__controls|role="status"/);
    for (const empty of [{}, { slides: [] }]) {
      const none = rendered(empty);
      expect(none).not.toMatch(/<ul|so-carousel/);
      expect(tags(none, 'h2')).toEqual(['Featured projects']);
    }
  });

  it('is still named when its heading is cleared', () => {
    expect(list(rendered({ heading: '', slides: SLIDES }))![1]).toContain('aria-label="Slides"');
  });

  it('names a list without a heading in the language of the site', async () => {
    const s = structuredClone(bundle.state);
    s.site.language = 'ar';
    const home = s.pages[s.site.homePageId];
    const placed = Object.values(home.nodes).find((n) => n.kind === 'instance' && n.definitionId === bundle.defs['media.carousel'].id) as InstanceNode;
    placed.props = { heading: '', slides: SLIDES };
    home.rootIds = [placed.id];
    expect(list(await renderRoute(s, s.site.homePageId))![1]).toContain('aria-label="الشرائح"');
  });

  it('shows three slides at a time on a desktop, two or one when chosen, and one with the edge of the next on a phone', () => {
    const css = componentsCss();
    const cls = nodeClass('media.carousel', 'slide');
    expect(css).toMatch(new RegExp(`\\.${cls}[^{]*\\{[^}]*width: 85%`));
    // The space between slides is the site's Large spacing, which the widths allow for whatever it is set to.
    expect(css).toMatch(/@media \(min-width: 1024px\)[\s\S]*width: calc\(\(100% - 2 \* var\(--so-space-lg\)\) \/ 3\)/);
    expect(css).toMatch(/--layout-two-columns[^{]*\{[^}]*width: calc\(\(100% - 1 \* var\(--so-space-lg\)\) \/ 2\)/);
    expect(css).toMatch(/--layout-one-column[^{]*\{[^}]*width: 100%/);
    expect(css).toMatch(new RegExp(`\\.${nodeClass('media.carousel', 'track')}[^{]*\\{[^}]*gap: var\\(--so-space-lg\\)`));
  });
});

describe('styles of one repeated item (#81)', () => {
  /** The opening tag of each element carrying the node's class, in rendered order. */
  const opening = (out: string, componentId: string, nodeId: string) => [...out.matchAll(/<(li|div)\b[^>]*>/g)].map((m) => m[0]).filter((t) => classed(nodeClass(componentId, nodeId)).test(t));

  it.each([
    ['features.grid', 'card', 'items', 'card', { title: 'Reading group' }, { title: 'Poetry evening' }],
    ['pricing.plans', 'plan', 'plans', 'plan', { name: 'Consultation' }, { name: 'Design' }],
    ['testimonials.grid', 'card', 'items', 'card', { quote: 'One' }, { quote: 'Two' }]
  ] as const)('%s puts the item class on that item’s %s only, wherever it is in the list', (componentId, partId, list, nodeId, first, second) => {
    const items = [{ id: 'i_reading', ...first }, { id: 'i_poetry', ...second }];
    const so_oi = { i_poetry: { [partId]: 'so-oi-test' } };
    const shown = opening(html(componentId, { [list]: items, so_oi }), componentId, nodeId);
    expect(shown).toHaveLength(2);
    expect(shown.map((t) => classed('so-oi-test').test(t))).toEqual([false, true]);
    // Reordered, the class stays with the item, not the position.
    const moved = opening(html(componentId, { [list]: [items[1], items[0]], so_oi }), componentId, nodeId);
    expect(moved.map((t) => classed('so-oi-test').test(t))).toEqual([true, false]);
  });
});
