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
  'content.pages'
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
