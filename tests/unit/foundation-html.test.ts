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
import type { ComponentDefinition } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { installComponent, makeInstance } from '@engine/install';
import { STYLES_DIR, defFile, generateProject } from '@generator/index';

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
  'cta.banner'
] as const;
type ComponentId = (typeof COMPONENTS)[number];

interface Rendered {
  render: (component: unknown, options: { props: Record<string, unknown> }) => { body: string };
  components: Record<string, unknown>;
}

const GEN = '\0gen:';

/** Every listed component, generated into one project and bundled for the server. */
async function bundleComponents(): Promise<{ module: Rendered; files: Map<string, string>; defs: Record<string, ComponentDefinition>; dir: string }> {
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
          if (id === '$app/paths' || id === '$app/state') return `\0${id}`;
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
  return { module: (await import(pathToFileURL(file).href)) as Rendered, files, defs, dir };
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

/** The generated stylesheet for every component. */
function componentsCss(): string {
  return bundle.files.get(`${STYLES_DIR}/components.css`) ?? '';
}

const tags = (markup: string, tag: string) => [...markup.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]);
const EMPTY_HEADING = /<h[1-6]\b[^>]*>\s*<\/h[1-6]>/;

describe('stats.row', () => {
  it('puts each label (dt) before its figure (dd), keeping the figure visually first', () => {
    const out = html('stats.row');
    const groups = [...out.matchAll(/<div class="[^"]*so-foundation-stats-row__figure[^"]*">([\s\S]*?)<\/div>/g)].map((m) => m[1]);
    expect(groups).toHaveLength(4);
    for (const group of groups) expect(group).toMatch(/^\s*<dt\b[^>]*>[^<]+<\/dt>\s*<dd\b[^>]*>[^<]+<\/dd>\s*$/);
    expect(componentsCss()).toMatch(/\.so-foundation-stats-row__value\s*\{[^}]*order:\s*-1/);
  });
});

describe('shell.footer', () => {
  const link = (label: string) => ({ id: label, label, link: { href: `/${label}/` } });

  it('leaves out a link group whose list is empty', () => {
    const out = html('shell.footer', { links: [], contact: [link('email')] });
    expect(tags(out, 'nav')).toHaveLength(1);
    expect(out).not.toContain('Explore');
    expect(out).toContain('Contact');
  });

  it('renders no navigation landmark when both lists are empty', () => {
    const out = html('shell.footer', { links: [], contact: [] });
    expect(out).not.toContain('<nav');
    expect(out).not.toContain('<h2');
  });

  it('keeps both groups, each labelled by its heading, when both have links', () => {
    const out = html('shell.footer', { links: [link('about')], contact: [link('email')] });
    const navs = [...out.matchAll(/<nav\b[^>]*aria-labelledby="([^"]+)"/g)].map((m) => m[1]);
    expect(navs).toHaveLength(2);
    for (const id of navs) expect(out).toMatch(new RegExp(`<h2\\b[^>]*id="${id}"[^>]*>[^<]+</h2>`));
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
    expect(html(componentId, { heading: 'A heading' })).toMatch(new RegExp(`<${tag}\\b[^>]*>A heading</${tag}>`));
    const cleared = html(componentId, { heading: '' });
    expect(cleared).not.toMatch(EMPTY_HEADING);
    expect(cleared).not.toMatch(new RegExp(`<${tag}\\b`));
  });
});

describe('empty action rows', () => {
  it.each(['hero.centered', 'hero.split', 'cta.banner'] as const)('%s leaves out the actions row when both labels are cleared', (componentId) => {
    const actions = new RegExp(`class="[^"]*so-foundation-${componentId.replace('.', '-')}__actions`);
    expect(html(componentId, { primaryLabel: 'Go', secondaryLabel: '' })).toMatch(actions);
    expect(html(componentId, { primaryLabel: '', secondaryLabel: 'More' })).toMatch(actions);
    expect(html(componentId, { primaryLabel: '', secondaryLabel: '' })).not.toMatch(actions);
  });
});

describe('testimonials.grid', () => {
  it('renders client names in <cite> upright by default', () => {
    expect(tags(html('testimonials.grid'), 'cite')).toContain('Amelia Hart');
    expect(bundle.files.get(`${STYLES_DIR}/theme.css`)).toMatch(/(^|[\s,}])cite\s*\{[^}]*font-style:\s*normal/);
  });
});

describe('team.grid', () => {
  it('leaves out an empty role', () => {
    const out = html('team.grid', { people: [{ id: 'a', name: 'Hannah Wells', role: '', bio: '', portrait: { src: null, alt: '' } }] });
    expect(out).toContain('Hannah Wells');
    expect(out).not.toMatch(/<p\b[^>]*>\s*<\/p>/);
  });
});
