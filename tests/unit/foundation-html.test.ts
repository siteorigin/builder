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
import { STYLES_DIR, defFile, generateProject, resolveInstanceProps } from '@generator/index';

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
  'data.table',
  'media.video'
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
          if (id === '\0$app/state') return "export const page = { route: { id: '/' }, url: new URL('https://site.test/') };";
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
function authoredHtml(componentId: ComponentId, props: Record<string, unknown>): string {
  const def = bundle.defs[componentId];
  const node: InstanceNode = { id: 'n_test', kind: 'instance', definitionId: def.id, props };
  return html(componentId, resolveInstanceProps(def, node, { state: bundle.state }));
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
