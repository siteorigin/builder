/**
 * The colours Foundation draws on its own grounds (issue #206), as a visitor sees them in a real headless browser:
 * the generated layout, sections and theme CSS exactly as an exported site ships them, compiled for the client and
 * mounted on a stand-in page. Each section is placed in a tone (default, soft, dark, brand), and beside its own
 * buttons and links the test drops the theme's primitives (a primary button, a text button, a link and a check
 * list) on its ground, inside a light card where the section has one, and into faded body text. Ratios are worked
 * out from the computed colours with the WCAG formula: 3:1 for focus outlines, button edges and check marks, 4.5:1
 * for text, at rest and on hover.
 */
import { existsSync } from 'node:fs';
import { posix } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { compile } from 'svelte/compiler';
import { build, type Rolldown } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InstanceNode, LinkValue, ResponsiveStyles } from '@shared/types';
import { parseColor, type Rgba } from '@shared/color';
import { compositeOver, contrastBetween } from '@shared/contrast';
import { createStarterState } from '@catalogue/starters';
import { installComponent, makeInstance } from '@engine/install';
import { STYLES_DIR, effectiveTokens, generateProject } from '@generator/index';

const browserInstalled = existsSync(chromium.executablePath());
const ORIGIN = 'https://site.test';

/** Where the theme's primitives are dropped in a section: on its ground, in a light card, or in faded rich text (links and checks only). */
interface Spot {
  selector: string;
  kind: 'all' | 'rich';
}
interface Placement {
  name: string;
  component: string;
  tone: string;
  spots: Spot[];
}

const on = (selector: string, kind: Spot['kind'] = 'all'): Spot => ({ selector, kind });
const INNER = "[class$='__inner']";
const PLACEMENTS: Placement[] = [
  ...['default', 'muted', 'inverse', 'brand'].map((tone) => ({ name: `hero.centered ${tone}`, component: 'hero.centered', tone, spots: [on(INNER)] })),
  { name: 'hero.split inverse', component: 'hero.split', tone: 'inverse', spots: [on(INNER)] },
  { name: 'contact.details inverse', component: 'contact.details', tone: 'inverse', spots: [on(INNER), on("[class$='__method']")] },
  // The Call to action's panel is the brand ground by default, dark or soft in its other tones.
  ...['default', 'inverse', 'muted'].map((tone) => ({ name: `cta.banner ${tone}`, component: 'cta.banner', tone, spots: [on("[class$='__panel']")] })),
  { name: 'content.text inverse', component: 'content.text', tone: 'inverse', spots: [on(INNER), on('.so-rich', 'rich')] },
  { name: 'layout.section inverse', component: 'layout.section', tone: 'inverse', spots: [on(INNER)] },
  // White cards inside a dark section keep the theme's own colours.
  { name: 'pricing.plans inverse', component: 'pricing.plans', tone: 'inverse', spots: [on(INNER), on("[class$='__plan']")] },
  { name: 'features.grid inverse', component: 'features.grid', tone: 'inverse', spots: [on(INNER), on("[class$='__card']")] },
  { name: 'contact.form inverse', component: 'contact.form', tone: 'inverse', spots: [on('.so-form__inner')] }
];

const page = (target: string): LinkValue => ({ type: 'page', target });

/** The exported site's files and its stylesheets, in the order the layout imports them. */
function exportedSite(opts: { placements?: Placement[]; header?: { surface?: string; root?: ResponsiveStyles } }) {
  const s = createStarterState('business', 'Test Studio', false);
  const [homeId, aboutId, contactId] = s.site.pageOrder;
  const home = s.pages[homeId];
  home.rootIds = [];
  home.nodes = {};
  // Every action gets somewhere to go, so it is a link a keyboard can reach.
  const links = { primaryLink: page(contactId), secondaryLink: page(aboutId), actionLink: page(contactId) };
  for (const p of opts.placements ?? []) {
    const def = s.components[installComponent(s, p.component)];
    const node = makeInstance(def, Object.fromEntries(Object.entries(links).filter(([k]) => k in def.properties)));
    node.variants = { tone: p.tone };
    home.nodes[node.id] = node;
    home.rootIds.push(node.id);
  }
  const header = Object.values(s.site.shell.header.nodes)[0] as InstanceNode;
  header.props = {
    ...header.props,
    links: [{ id: 'l1', label: 'About', link: page(aboutId) }, { id: 'l2', label: 'Contact', link: page(contactId) }],
    ctaLabel: 'Book a call',
    ctaLink: page(contactId),
    surface: opts.header?.surface ?? 'background'
  };
  if (opts.header?.root) header.overrides = { root: opts.header.root };
  const files = generateProject(s);
  const css = ['tokens', 'theme', 'components', 'site'].map((n) => files.get(`${STYLES_DIR}/${n}.css`) ?? '').join('\n');
  // A token's colour as the browser computes it.
  const tokens = effectiveTokens(s);
  const computed = (id: string) => {
    const c = parseColor(String(tokens.find((t) => t.id === id)!.value))!;
    return `rgb(${c.r}, ${c.g}, ${c.b})`;
  };
  return { files, css, colors: { brand: computed('color.brand'), onBrand: computed('color.on-brand'), focus: computed('color.focus') } };
}

/** Every case's layout and home page as one script that defines `window.mountCase(name)`. */
async function bundleSites(sites: Record<string, Map<string, string>>): Promise<string> {
  const src = new Map<string, string>();
  for (const [name, files] of Object.entries(sites)) {
    for (const [path, text] of files) src.set(`\0site/${name}/${path}`, text);
    src.set(`\0site/${name}/Entry.svelte`, `<script>import Layout from './src/routes/+layout.svelte'; import Page from './src/routes/+page.svelte';</script><Layout><Page /></Layout>`);
  }
  const names = Object.keys(sites);
  const entry = [
    "import { mount } from 'svelte';",
    ...names.map((n, i) => `import E${i} from '\0site/${n}/Entry.svelte';`),
    `const all = { ${names.map((n, i) => `${JSON.stringify(n)}: E${i}`).join(', ')} };`,
    "window.mountCase = (name) => mount(all[name], { target: document.getElementById('app') });"
  ].join('\n');
  const out = (await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'exported-site',
        resolveId(id, importer) {
          if (id === '\0entry') return id;
          if (id === '$app/paths' || id === '$app/state' || id === '$app/navigation') return `\0${id}`;
          if (id.startsWith('@fontsource') || id.endsWith('.css')) return '\0empty';
          if (importer?.startsWith('\0site/') && id.startsWith('.')) {
            const path = `\0${posix.join(posix.dirname(importer.slice(1)), id)}`;
            if (src.has(path)) return path;
          }
          return src.has(id) ? id : null;
        },
        load(id) {
          if (id === '\0entry') return entry;
          if (id === '\0empty') return '';
          if (id === '\0$app/paths') return 'export const base = ""; export const resolve = (p) => p; export const asset = (p) => "/" + p;';
          if (id === '\0$app/state') return 'export const page = { route: { id: "/" }, url: new URL("https://site.test/") };';
          if (id === '\0$app/navigation') return 'export const afterNavigate = () => {}; export const beforeNavigate = () => {}; export const snapshot = () => {};';
          const text = src.get(id);
          if (text === undefined) return null;
          return id.endsWith('.svelte') ? compile(text, { filename: id.slice(1), generate: 'client', css: 'injected' }).js.code : text;
        }
      }
    ],
    build: { write: false, minify: false, rolldownOptions: { input: '\0entry', output: { format: 'iife', codeSplitting: false } } }
  })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[];
  const chunk = (Array.isArray(out) ? out[0] : out).output.find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('The exported site did not bundle');
  return chunk.code;
}

/** A computed colour as Chromium writes it: rgb(), rgba() or color(srgb ...), the last for a color-mix(). */
function rgba(css: string): Rgba {
  const legacy = css.match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/);
  if (legacy) return { r: +legacy[1], g: +legacy[2], b: +legacy[3], a: legacy[4] === undefined ? 1 : +legacy[4] };
  const srgb = css.match(/^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)$/);
  if (srgb) return { r: +srgb[1] * 255, g: +srgb[2] * 255, b: +srgb[3] * 255, a: srgb[4] === undefined ? 1 : +srgb[4] };
  throw new Error(`Unexpected computed colour: ${css}`);
}

/** One element's computed colours, and the background and opacity of each element above it, nearest first. */
interface Sample {
  label: string;
  role: 'primary' | 'text' | 'link' | 'check' | 'control' | 'menu' | 'current';
  color: string;
  background: string;
  outline: { color: string; style: string; width: string; focusVisible: boolean } | null;
  check?: { mark: string; disc: string };
  /** A current-page link's underline. */
  current?: string;
  above: Array<{ background: string; opacity: string }>;
  opacity: string;
}

// Run in the browser, so they are passed as text (the Node project has no DOM types). Both read colours only once
// every transition has finished (see settle): the theme's reduced-motion rule leaves a 0.01ms one on every property.
const SAMPLE_FN = `(el, role) => {
  const cs = getComputedStyle(el);
  const above = [];
  for (let p = el.parentElement; p; p = p.parentElement) above.push({ background: getComputedStyle(p).backgroundColor, opacity: getComputedStyle(p).opacity });
  const outline = null;
  const check = role === 'check' ? { mark: getComputedStyle(el, '::after').borderRightColor, disc: getComputedStyle(el, '::before').backgroundColor } : undefined;
  const current = role === 'current' ? getComputedStyle(el, '::after').backgroundColor : undefined;
  return { label: el.dataset.label, role, color: cs.color, background: cs.backgroundColor, outline, check, current, above, opacity: cs.opacity };
}`;

const OUTLINE_FN = `(el) => {
  const f = getComputedStyle(el);
  return { color: f.outlineColor, style: f.outlineStyle, width: f.outlineWidth, focusVisible: el.matches(':focus-visible') };
}`;

/** What one sample shows: each ratio it must reach, with the minimum, named for the failure message. */
function ratios(s: Sample): Array<[what: string, ratio: number, min: number]> {
  const white: Rgba = { r: 255, g: 255, b: 255, a: 1 };
  // The ground: every background above, painted top down over white.
  const ground = [...s.above].reverse().reduce((under, a) => compositeOver(rgba(a.background), under), white);
  // Opacity on the element or above it fades everything it paints.
  const fade = [s.opacity, ...s.above.map((a) => a.opacity)].reduce((f, o) => f * +o, 1);
  const painted = (css: string, under: Rgba) => {
    const c = rgba(css);
    return compositeOver({ ...c, a: c.a * fade }, under);
  };
  const out: Array<[string, number, number]> = [];
  if (s.outline) out.push(['focus outline', contrastBetween(painted(s.outline.color, ground), ground), 3]);
  if (s.role === 'primary') {
    const fill = painted(s.background, ground);
    out.push(['button edge', contrastBetween(fill, ground), 3], ['button text', contrastBetween(painted(s.color, fill), fill), 4.5]);
  }
  if (s.role === 'text' || s.role === 'link' || s.role === 'menu') out.push(['text', contrastBetween(painted(s.color, ground), ground), 4.5]);
  if (s.check) {
    // The li carries no background of its own: the disc lies on the ground, the mark on the disc.
    const disc = painted(s.check.disc, ground);
    out.push(['check mark', contrastBetween(painted(s.check.mark, disc), disc), 3]);
  }
  if (s.current) out.push(['current-page mark', contrastBetween(painted(s.current, ground), ground), 3]);
  return out;
}

const failures = (samples: Sample[]) =>
  samples.flatMap((s) => ratios(s).filter(([, r, min]) => r < min).map(([what, r, min]) => `${s.label}: ${what} ${r.toFixed(2)}:1 < ${min}:1`));

describe.skipIf(!browserInstalled)('Foundation colours on dark and brand grounds (#206)', () => {
  let browser: Browser;
  let script: string;
  const sites = {
    sections: exportedSite({ placements: PLACEMENTS }),
    'header-dark': exportedSite({ header: { surface: 'inverse' } }),
    // An author's own dark header: the phone menu used to stay cream under the header's light text.
    'header-custom': exportedSite({ header: { root: { base: { background: '#1d2b4f', color: '#ffffff' } } } }),
    'header-default': exportedSite({})
  };

  beforeAll(async () => {
    const [bundled, launched] = await Promise.allSettled([
      bundleSites(Object.fromEntries(Object.entries(sites).map(([name, site]) => [name, site.files]))),
      chromium.launch({ headless: true, executablePath: chromium.executablePath(), timeout: 30_000 })
    ]);
    if (launched.status === 'fulfilled') browser = launched.value;
    if (bundled.status === 'rejected') throw bundled.reason;
    if (launched.status === 'rejected') throw launched.reason;
    script = bundled.value;
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
  });

  async function withPage(name: keyof typeof sites, width: number, body: (page: Page) => Promise<void>) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    context.setDefaultTimeout(10_000);
    try {
      const p = await context.newPage();
      await p.route(`${ORIGIN}/**`, (route) => {
        if (new URL(route.request().url()).pathname === '/site.js') return route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: script });
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${sites[name].css}</style></head><body><div id="app" style="display: contents"></div><script src="/site.js"></script><script>mountCase(${JSON.stringify(name)})</script></body></html>`
        });
      });
      await p.goto(`${ORIGIN}/`);
      await p.locator('header.so-header').waitFor();
      await body(p);
    } finally {
      await context.close();
    }
  }

  /** Waits out every transition: the theme's reduced-motion rule still runs a 0.01ms one on every property. */
  const settle = (p: Page) => p.evaluate('Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})))');
  const at = (label: string) => `document.querySelector(${JSON.stringify(`[data-label=${JSON.stringify(label)}]`)})`;
  const sample = async (p: Page, label: string) => (await p.evaluate(`(${SAMPLE_FN})(${at(label)}, ${at(label)}.dataset.role)`)) as Sample;
  const focusable = (s: Sample) => s.role !== 'check' && s.role !== 'menu';

  /** Samples every labelled element: at rest, with its keyboard focus outline, and hovered. */
  async function sampleAll(p: Page): Promise<{ rest: Sample[]; hover: Sample[] }> {
    await settle(p);
    const labels = (await p.evaluate(`[...document.querySelectorAll('[data-label]')].map((el) => el.dataset.label)`)) as string[];
    const rest: Sample[] = [];
    for (const label of labels) rest.push(await sample(p, label));
    // A Tab first, so focus moved by script after it shows the keyboard outline.
    await p.keyboard.press('Tab');
    for (const s of rest.filter(focusable)) {
      await p.evaluate(`${at(s.label)}.focus()`);
      await settle(p);
      s.outline = (await p.evaluate(`(${OUTLINE_FN})(${at(s.label)})`)) as Sample['outline'];
    }
    await p.evaluate('document.activeElement?.blur()');
    const hover: Sample[] = [];
    for (const s of rest.filter((r) => r.role === 'primary' || r.role === 'text' || r.role === 'link')) {
      const el = p.locator(`[data-label=${JSON.stringify(s.label)}]`);
      await el.scrollIntoViewIfNeeded();
      await el.hover();
      await settle(p);
      hover.push({ ...(await sample(p, s.label)), label: `${s.label} (hover)` });
    }
    return { rest, hover };
  }

  it('reads on every tone: focus outlines, buttons, links and check marks, at rest and on hover, and white cards keep the theme colours', async () => {
    await withPage('sections', 1280, async (p) => {
      // Each placement's root, in page order, then the primitives dropped in each of its spots.
      const placed = await p.evaluate(
        `((placements) => {
          const roots = [...document.querySelectorAll('main > *')];
          if (roots.length !== placements.length) return 'Expected ' + placements.length + ' sections, found ' + roots.length;
          const label = (el, name, role) => { el.dataset.label = name; el.dataset.role = role; };
          placements.forEach((pl, i) => {
            const root = roots[i];
            // The section's own controls, as an author leaves them.
            root.querySelectorAll('a[href], button:not(:disabled), input:not([type=hidden]):not(:disabled), textarea, select, summary').forEach((el, j) => {
              if (el.closest('.so-form__trap')) return;
              const role = el.matches('.so-btn--primary') ? 'primary' : el.matches('.so-btn--text') ? 'text' : 'control';
              label(el, pl.name + ' own ' + j + ' ' + (el.textContent.trim() || el.getAttribute('name') || el.tagName), role);
            });
            for (const spot of pl.spots) {
              const at = root.querySelector(spot.selector);
              if (!at) return void (label(root, pl.name + ' missing ' + spot.selector, 'control'));
              const where = pl.name + ' ' + spot.selector;
              const box = document.createElement('div');
              box.innerHTML = spot.kind === 'rich'
                ? '<p><a class="so-link" href="#link">An inline link</a></p><ul class="so-rich--check"><li>A checked item</li></ul>'
                : '<a class="so-btn so-btn--primary" href="#primary">Primary</a> <a class="so-btn so-btn--text" href="#text">Read more</a> <a class="so-link" href="#link">A link</a><ul class="so-rich so-rich--check"><li>A checked item</li></ul>';
              at.append(box);
              box.querySelectorAll('.so-btn--primary').forEach((el) => label(el, where + ' primary', 'primary'));
              box.querySelectorAll('.so-btn--text').forEach((el) => label(el, where + ' text button', 'text'));
              box.querySelectorAll('.so-link').forEach((el) => label(el, where + ' link', 'link'));
              box.querySelectorAll('li').forEach((el) => label(el, where + ' check', 'check'));
            }
          });
          return null;
        })(${JSON.stringify(PLACEMENTS)})`
      );
      expect(placed).toBeNull();
      // The footer is dark by default, and its links are faded.
      await p.evaluate(`document.querySelectorAll('footer a[href]').forEach((el, i) => { el.dataset.label = 'footer link ' + i; el.dataset.role = 'control'; })`);
      const { rest, hover } = await sampleAll(p);
      expect(rest.filter((s) => s.label.includes(' missing '))).toEqual([]);
      // Every focusable element showed a keyboard outline to measure.
      expect(rest.filter((s) => s.outline && !(s.outline.focusVisible && s.outline.style !== 'none' && parseFloat(s.outline.width) >= 2)).map((s) => s.label)).toEqual([]);
      for (const name of ['hero.centered brand', 'cta.banner default', 'hero.centered inverse', 'content.text inverse', 'footer link']) expect(rest.some((s) => s.label.startsWith(name)), name).toBe(true);
      expect(failures(rest)).toEqual([]);
      expect(failures(hover)).toEqual([]);
    });
  }, 120_000);

  it('keeps the theme colours on light grounds: brand buttons, links and check marks and the focus colour', async () => {
    await withPage('sections', 1280, async (p) => {
      await p.evaluate(`(() => {
        const root = document.querySelectorAll('main > *')[0];
        root.querySelector("[class$='__inner']").insertAdjacentHTML('beforeend', '<a class="so-btn so-btn--primary" href="#p" data-probe="primary">P</a><a class="so-link" href="#l" data-probe="link">L</a><ul class="so-rich so-rich--check"><li data-probe="check">C</li></ul>');
        const card = document.querySelectorAll('main > *')[${PLACEMENTS.findIndex((pl) => pl.component === 'pricing.plans')}].querySelector("[class$='__plan']");
        card.insertAdjacentHTML('beforeend', '<a class="so-link" href="#l2" data-probe="card-link">L</a>');
      })()`);
      await settle(p);
      const read = async (probe: string, js: string) => {
        await settle(p);
        return p.evaluate(`(() => { const el = document.querySelector('[data-probe=${probe}]'); return ${js}; })()`);
      };
      const { brand, onBrand, focus } = sites.sections.colors;
      expect(await read('primary', 'getComputedStyle(el).backgroundColor')).toBe(brand);
      expect(await read('primary', 'getComputedStyle(el).color')).toBe(onBrand);
      expect(await read('link', 'getComputedStyle(el).color')).toBe(brand);
      expect(await read('card-link', 'getComputedStyle(el).color')).toBe(brand);
      expect(await read('check', "getComputedStyle(el, '::after').borderRightColor")).toBe(brand);
      await p.keyboard.press('Tab');
      for (const probe of ['primary', 'link', 'card-link']) {
        await p.evaluate(`document.querySelector('[data-probe=${probe}]').focus()`);
        expect(await read(probe, 'getComputedStyle(el).outlineColor'), probe).toBe(focus);
      }
    });
  }, 60_000);

  it('shows a dark header’s action and links readably, and its current-page mark in the header’s text colour', async () => {
    await withPage('header-dark', 1280, async (p) => {
      await p.evaluate(`(() => {
        const cta = document.querySelector('.so-header__cta'); cta.dataset.label = 'header action'; cta.dataset.role = 'primary';
        document.querySelectorAll('.so-header__nav ul a, .so-header__brand').forEach((el, i) => { el.dataset.label = 'header link ' + i; el.dataset.role = 'control'; });
        const current = document.querySelector('.so-header__nav ul a');
        current.setAttribute('aria-current', 'page');
        current.dataset.role = 'current';
      })()`);
      const { rest, hover } = await sampleAll(p);
      expect(rest.map((s) => s.label)).toContain('header action');
      expect(rest.filter((s) => s.current).length).toBe(1);
      expect(failures(rest)).toEqual([]);
      expect(failures(hover)).toEqual([]);
    });
  }, 60_000);

  for (const [name, why] of [
    ['header-custom', 'an author’s own dark background and light text'],
    ['header-dark', 'the Dark background'],
    ['header-default', 'the page background']
  ] as const) {
    it(`opens the phone menu in the header’s own colours, with ${why}`, async () => {
      await withPage(name, 390, async (p) => {
        await p.locator('.so-header__toggle').click();
        await p.locator('.so-header__nav').waitFor({ state: 'visible' });
        await settle(p);
        const header = (await p.evaluate(`getComputedStyle(document.querySelector('header.so-header')).backgroundColor`)) as string;
        expect(await p.evaluate(`getComputedStyle(document.querySelector('.so-header__nav')).backgroundColor`)).toBe(header);
        await p.evaluate(`document.querySelectorAll('.so-header__nav ul a').forEach((el, i) => { el.dataset.label = 'menu link ' + i; el.dataset.role = 'menu'; })`);
        const samples = (await p.evaluate(`[...document.querySelectorAll('[data-label]')].map((el) => (${SAMPLE_FN})(el, el.dataset.role))`)) as Sample[];
        expect(samples.length).toBe(2);
        expect(failures(samples)).toEqual([]);
      });
    }, 60_000);
  }
});
