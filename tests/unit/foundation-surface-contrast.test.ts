/**
 * The colours Foundation draws on its own grounds (issue #206), as a visitor sees them in a real headless browser:
 * the generated layout, sections and theme CSS exactly as an exported site ships them, compiled for the client and
 * mounted on a stand-in page. Each section is placed in a tone (default, soft, dark, brand), and beside its own
 * buttons and links the test drops the theme's primitives (a primary button, a text button, a link and a check
 * list) on its ground, inside a light card where the section has one, and into faded body text. Ratios are worked
 * out from the computed colours with the WCAG formula: 3:1 for focus outlines, button edges and check marks, 4.5:1
 * for text, at rest and on hover. Each spot also says which colour it draws in: the ground's own text colour on a
 * dark or brand ground, the theme's brand and focus colours on a light one.
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
import { applyOperations } from '@engine/apply';
import { STYLES_DIR, effectiveTokens, generateProject } from '@generator/index';

const browserInstalled = existsSync(chromium.executablePath());
const ORIGIN = 'https://site.test';

/**
 * The colour a ground draws in: the theme's own (brand links and buttons, the focus colour), the same with text buttons
 * in the ground's text colour (a soft panel's), or a dark or brand ground's text colour.
 */
type Ink = 'theme' | 'theme-text' | 'on-inverse' | 'on-brand';
/** Where the theme's primitives are dropped in a section: on its ground, in a light card, or in faded rich text (links and checks only). */
interface Spot {
  selector: string;
  ink: Ink;
  rich?: boolean;
}
interface Placement {
  name: string;
  component: string;
  tone: string;
  spots: Spot[];
  /** Placed as a copy of the definition, as Make unique and Duplicate leave it: a project id, the same parts. */
  copy?: boolean;
  /** Moved inside another placement's container, as a section placed in a Section's slot. */
  nestIn?: string;
  /** The colour the section's own controls draw their focus outline in, where it is the same for all of them. */
  ownInk?: Ink;
}

// A section's container, wherever its class comes in the list (a layout option that styles it adds its own after it).
const INNER = ":is([class$='__inner'], [class*='__inner '])";
/** A part a tone styles carries the tone's class after its own, so its class is matched anywhere in the list. */
const PANEL = ":is([class$='__panel'], [class*='__panel '])";
/** A light card in a section (a contact method, a plan, a feature), which carries the theme's surface class after its own. */
const card = (name: string) => `:is([class$='__${name}'], [class*='__${name} '])`;
const at = (selector: string, ink: Ink, rich = false): Spot => ({ selector, ink, rich });
const PLACEMENTS: Placement[] = [
  { name: 'hero.centered default', component: 'hero.centered', tone: 'default', spots: [at(INNER, 'theme')] },
  { name: 'hero.centered muted', component: 'hero.centered', tone: 'muted', spots: [at(INNER, 'theme')] },
  { name: 'hero.centered inverse', component: 'hero.centered', tone: 'inverse', spots: [at(INNER, 'on-inverse')] },
  { name: 'hero.centered brand', component: 'hero.centered', tone: 'brand', spots: [at(INNER, 'on-brand')], ownInk: 'on-brand' },
  { name: 'hero.split inverse', component: 'hero.split', tone: 'inverse', spots: [at(INNER, 'on-inverse')], ownInk: 'on-inverse' },
  { name: 'contact.details inverse', component: 'contact.details', tone: 'inverse', spots: [at(INNER, 'on-inverse'), at(card('method'), 'theme')] },
  // The Call to action's panel is the brand ground by default, dark or soft in its other tones; around it is the page.
  { name: 'cta.banner default', component: 'cta.banner', tone: 'default', spots: [at(PANEL, 'on-brand')], ownInk: 'on-brand' },
  { name: 'cta.banner inverse', component: 'cta.banner', tone: 'inverse', spots: [at(PANEL, 'on-inverse'), at(INNER, 'theme')], ownInk: 'on-inverse' },
  // On the soft panel its own button takes the brand's fill and its text button the panel's text colour.
  { name: 'cta.banner muted', component: 'cta.banner', tone: 'muted', spots: [at(PANEL, 'theme')], ownInk: 'theme-text' },
  { name: 'content.text inverse', component: 'content.text', tone: 'inverse', spots: [at(INNER, 'on-inverse'), at('.so-rich', 'on-inverse', true)] },
  { name: 'layout.section inverse', component: 'layout.section', tone: 'inverse', spots: [at(INNER, 'on-inverse')] },
  // A light section placed in a dark one starts afresh.
  { name: 'intro.page default in a dark section', component: 'intro.page', tone: 'default', spots: [at(INNER, 'theme')], nestIn: 'layout.section inverse' },
  // White cards inside a dark section keep the theme's own colours, in a copy of the section too.
  { name: 'pricing.plans inverse', component: 'pricing.plans', tone: 'inverse', spots: [at(INNER, 'on-inverse'), at(card('plan'), 'theme')] },
  { name: 'features.grid inverse', component: 'features.grid', tone: 'inverse', spots: [at(INNER, 'on-inverse'), at(card('card'), 'theme')] },
  { name: 'features.grid inverse copy', component: 'features.grid', tone: 'inverse', copy: true, spots: [at(INNER, 'on-inverse'), at(card('card'), 'theme')] },
  // Testimonials stand on the section's own ground, each under a hairline rather than in a card.
  { name: 'testimonials.grid inverse', component: 'testimonials.grid', tone: 'inverse', spots: [at(INNER, 'on-inverse')] },
  { name: 'faq.list inverse', component: 'faq.list', tone: 'inverse', spots: [at(INNER, 'on-inverse')] },
  { name: 'contact.form inverse', component: 'contact.form', tone: 'inverse', spots: [at('.so-form__inner', 'on-inverse')], ownInk: 'on-inverse' },
  { name: 'site.search inverse', component: 'site.search', tone: 'inverse', spots: [at('.so-search__inner', 'on-inverse')], ownInk: 'on-inverse' }
];

const page = (target: string): LinkValue => ({ type: 'page', target });

/** The exported site's files and its stylesheets, in the order the layout imports them, and the colours each ink computes to. */
function exportedSite(opts: { placements?: Placement[]; header?: { surface?: string; root?: ResponsiveStyles } }) {
  let s = createStarterState('business', 'Test Studio', false);
  const defs = (opts.placements ?? []).map((p) => {
    const id = installComponent(s, p.component);
    if (!p.copy) return id;
    const copied = applyOperations(s, [{ type: 'component.duplicate', definitionId: id, name: `Spare ${p.component}` }]);
    s = copied.state;
    return copied.results[0].definitionId as string;
  });
  const [homeId, aboutId, contactId] = s.site.pageOrder;
  const home = s.pages[homeId];
  home.rootIds = [];
  home.nodes = {};
  // Every action gets somewhere to go, so it is a link a keyboard can reach.
  const links = { primaryLink: page(contactId), secondaryLink: page(aboutId), actionLink: page(contactId) };
  (opts.placements ?? []).forEach((p, i) => {
    const def = s.components[defs[i]];
    const node = makeInstance(def, Object.fromEntries(Object.entries(links).filter(([k]) => k in def.properties)));
    node.variants = { tone: p.tone };
    home.nodes[node.id] = node;
    home.rootIds.push(node.id);
  });
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
  const colors = {
    brand: computed('color.brand'),
    onBrand: computed('color.on-brand'),
    focus: computed('color.focus'),
    text: computed('color.text'),
    inverse: computed('color.inverse'),
    onInverse: computed('color.on-inverse')
  };
  return { files, css, colors };
}
type Colors = ReturnType<typeof exportedSite>['colors'];

/** What a spot's ink paints: links and text buttons, a primary button's fill, and the focus outline. */
function inkColors(ink: Ink, c: Colors) {
  if (ink === 'on-inverse') return { link: c.onInverse, fill: c.onInverse, outline: c.onInverse };
  if (ink === 'on-brand') return { link: c.onBrand, fill: c.onBrand, outline: c.onBrand };
  if (ink === 'theme-text') return { link: c.text, fill: c.brand, outline: c.focus };
  return { link: c.brand, fill: c.brand, outline: c.focus };
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
          if (id === '\0$app/navigation') return 'export const afterNavigate = () => {}; export const onNavigate = () => {}; export const beforeNavigate = () => {}; export const snapshot = () => {};';
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
function rgba(css: string, where: string): Rgba {
  const legacy = css.match(/^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/);
  if (legacy) return { r: +legacy[1], g: +legacy[2], b: +legacy[3], a: legacy[4] === undefined ? 1 : +legacy[4] };
  const srgb = css.match(/^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)$/);
  if (srgb) return { r: +srgb[1] * 255, g: +srgb[2] * 255, b: +srgb[3] * 255, a: srgb[4] === undefined ? 1 : +srgb[4] };
  throw new Error(`${where}: unexpected computed colour ${css}`);
}

/** One element's computed colours, and the background and opacity of each element above it, nearest first. */
interface Sample {
  id: string;
  label: string;
  /** `light`: a light button, filled with the brand's text colour on every ground. */
  role: 'primary' | 'light' | 'text' | 'link' | 'check' | 'control' | 'menu' | 'current';
  /** The colour this element should draw its focus outline in, links and button fill in, when the test knows it. */
  ink?: Ink;
  color: string;
  background: string;
  outline: { color: string; style: string; width: string; focusVisible: boolean } | null;
  /** A check list item's disc (::before) and mark (::after), with what makes the mark show. */
  check?: { mark: string; disc: string; content: string; width: string };
  /** A current-page link's mark: a 2 px rule its menu item draws under it (the item's ::after bottom border). */
  current?: { color: string; content: string; height: string };
  above: Array<{ background: string; opacity: string }>;
  opacity: string;
}

// Run in the browser, so they are passed as text (the Node project has no DOM types). Colours are read only once
// every transition has finished (see settle): the theme's reduced-motion rule leaves a 0.01ms one on every property.
const SAMPLE_FN = `(el) => {
  const cs = getComputedStyle(el);
  const role = el.dataset.role;
  const above = [];
  for (let p = el.parentElement; p; p = p.parentElement) above.push({ background: getComputedStyle(p).backgroundColor, opacity: getComputedStyle(p).opacity });
  const after = getComputedStyle(el, '::after');
  const check = role === 'check' ? { mark: after.borderRightColor, disc: getComputedStyle(el, '::before').backgroundColor, content: after.content, width: after.borderRightWidth } : undefined;
  const mark = role === 'current' ? getComputedStyle(el.closest('li'), '::after') : undefined;
  const current = mark ? { color: mark.borderBottomColor, content: mark.content, height: mark.borderBottomWidth } : undefined;
  return { id: el.dataset.probeId, label: el.dataset.label, role, ink: el.dataset.ink || undefined, color: cs.color, background: cs.backgroundColor, outline: null, check, current, above, opacity: cs.opacity };
}`;

// A search query's ring goes round the whole search row it sits in, the row's button included.
const OUTLINE_FN = `(el) => {
  const f = getComputedStyle(el.matches('.so-search__input') ? el.closest('.so-search__row') : el);
  return { color: f.outlineColor, style: f.outlineStyle, width: f.outlineWidth, focusVisible: el.matches(':focus-visible') };
}`;

/** Labels an element for sampling: a numeric id to find it by, a name for messages, its role and the ink it should draw in. */
const LABEL_FN = `(el, label, role, ink) => {
  window.__probes = (window.__probes || 0) + 1;
  el.dataset.probeId = String(window.__probes);
  el.dataset.label = label;
  el.dataset.role = role;
  if (ink) el.dataset.ink = ink;
}`;

/** What one sample shows: each ratio it must reach, with the minimum, named for the failure message. */
function ratios(s: Sample): Array<[what: string, ratio: number, min: number]> {
  const color = (css: string) => rgba(css, s.label);
  const white: Rgba = { r: 255, g: 255, b: 255, a: 1 };
  // The ground: every background above, painted top down over white (the grounds here are opaque and unfaded).
  const ground = [...s.above].reverse().reduce((under, a) => compositeOver(color(a.background), under), white);
  // Opacity on the element or above it fades what it paints as one group: composed first, then laid on the ground.
  const fade = [s.opacity, ...s.above.map((a) => a.opacity)].reduce((f, o) => f * +o, 1);
  const shown = (c: Rgba) => compositeOver({ ...c, a: c.a * fade }, ground);
  const out: Array<[string, number, number]> = [];
  if (s.outline) out.push(['focus outline', contrastBetween(shown(color(s.outline.color)), ground), 3]);
  if (s.role === 'primary' || s.role === 'light') {
    const fill = color(s.background);
    expect(fill.a, `${s.label}: an opaque button fill`).toBe(1);
    out.push(['button edge', contrastBetween(shown(fill), ground), 3], ['button text', contrastBetween(shown(compositeOver(color(s.color), fill)), shown(fill)), 4.5]);
  }
  if (s.role === 'text' || s.role === 'link' || s.role === 'menu') out.push(['text', contrastBetween(shown(color(s.color)), ground), 4.5]);
  if (s.check) {
    // The li has no background: the disc lies on the ground and the (opaque) mark on the disc, faded together.
    const mark = color(s.check.mark);
    expect(mark.a, `${s.label}: an opaque check mark`).toBe(1);
    out.push(['check mark', contrastBetween(shown(mark), shown(color(s.check.disc))), 3]);
  }
  if (s.current) out.push(['current-page mark', contrastBetween(shown(color(s.current.color)), ground), 3]);
  return out;
}

const failures = (samples: Sample[]) =>
  samples.flatMap((s) => ratios(s).filter(([, r, min]) => r < min).map(([what, r, min]) => `${s.label}: ${what} ${r.toFixed(2)}:1 < ${min}:1`));

/** The samples whose colours are not the ones their ink paints: the focus outline, and a link's or a button fill's colour. */
function wrongInk(samples: Sample[], c: Colors): string[] {
  const out: string[] = [];
  for (const s of samples) {
    if (!s.ink) continue;
    const want = inkColors(s.ink, c);
    if (s.outline && s.outline.color !== want.outline) out.push(`${s.label}: focus outline ${s.outline.color}, not ${want.outline}`);
    if ((s.role === 'link' || s.role === 'text') && s.color !== want.link) out.push(`${s.label}: ${s.color}, not ${want.link}`);
    if (s.role === 'primary' && s.background !== want.fill) out.push(`${s.label}: fill ${s.background}, not ${want.fill}`);
    if (s.check && s.check.mark !== want.link) out.push(`${s.label}: mark ${s.check.mark}, not ${want.link}`);
  }
  return out;
}

describe.skipIf(!browserInstalled)('Foundation colours on dark and brand grounds (#206)', () => {
  let browser: Browser;
  let script: string;
  let sites: Record<'sections' | 'header-dark' | 'header-custom' | 'header-gradient' | 'header-default', ReturnType<typeof exportedSite>>;

  beforeAll(async () => {
    sites = {
      sections: exportedSite({ placements: PLACEMENTS }),
      'header-dark': exportedSite({ header: { surface: 'inverse' } }),
      // An author's own dark header: the phone menu used to stay cream under the header's light text.
      'header-custom': exportedSite({ header: { root: { base: { background: '#1d2b4f', color: '#ffffff' } } } }),
      'header-gradient': exportedSite({ header: { root: { base: { background: 'linear-gradient(90deg, #1d2b4f, #14211d)', color: '#ffffff' } } } }),
      'header-default': exportedSite({})
    };
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
          body: `<!doctype html><html lang="en" class="so-js"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${sites[name].css}</style></head><body><div id="app" style="display: contents"></div><script src="/site.js"></script><script>mountCase(${JSON.stringify(name)})</script></body></html>`
        });
      });
      await p.goto(`${ORIGIN}/`);
      await p.locator('header.so-header').waitFor();
      await body(p);
    } finally {
      await context.close();
    }
  }

  /** Waits out every transition (the theme's reduced-motion rule still runs a 0.01ms one on every property), for at most two seconds. */
  const settle = (p: Page) =>
    p.evaluate('Promise.race([Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))), new Promise((done) => setTimeout(done, 2000))])');
  const byId = (id: string) => `document.querySelector('[data-probe-id="${id}"]')`;
  const sample = async (p: Page, id: string) => (await p.evaluate(`(${SAMPLE_FN})(${byId(id)})`)) as Sample;
  const label = (p: Page, selector: string, js: string) => p.evaluate(`(() => { const label = ${LABEL_FN}; document.querySelectorAll(${JSON.stringify(selector)}).forEach((el, i) => { ${js} }); })()`);

  /** Samples every labelled element: at rest, with its keyboard focus outline, and hovered. */
  async function sampleAll(p: Page): Promise<{ rest: Sample[]; hover: Sample[] }> {
    await settle(p);
    const ids = (await p.evaluate(`[...document.querySelectorAll('[data-probe-id]')].map((el) => el.dataset.probeId)`)) as string[];
    const rest: Sample[] = [];
    for (const id of ids) rest.push(await sample(p, id));
    // A Tab first, so focus moved by script after it shows the keyboard outline.
    await p.keyboard.press('Tab');
    for (const s of rest.filter((r) => r.role !== 'check' && r.role !== 'menu')) {
      await p.evaluate(`${byId(s.id)}.focus()`);
      await settle(p);
      s.outline = (await p.evaluate(`(${OUTLINE_FN})(${byId(s.id)})`)) as Sample['outline'];
    }
    await p.evaluate('document.activeElement?.blur()');
    const hover: Sample[] = [];
    for (const s of rest.filter((r) => ['primary', 'light', 'text', 'link'].includes(r.role))) {
      await p.locator(`[data-probe-id="${s.id}"]`).hover();
      await settle(p);
      hover.push({ ...(await sample(p, s.id)), label: `${s.label} (hover)` });
    }
    return { rest, hover };
  }

  /** Every element focused showed a keyboard outline, at least 2px wide, to measure. */
  const unoutlined = (samples: Sample[]) => samples.filter((s) => s.outline && !(s.outline.focusVisible && s.outline.style !== 'none' && parseFloat(s.outline.width) >= 2)).map((s) => s.label);

  it('reads on every tone: focus outlines, buttons, links and check marks, at rest and on hover, in the colours of their ground', async () => {
    await withPage('sections', 1280, async (p) => {
      // Each placement's root, in page order, checked by its tone; then its own controls and the primitives dropped in each spot.
      const placed = await p.evaluate(
        `((placements) => {
          const label = ${LABEL_FN};
          const roots = [...document.querySelectorAll('main > *')];
          if (roots.length !== placements.length) return 'Expected ' + placements.length + ' sections, found ' + roots.length;
          for (const [i, pl] of placements.entries()) {
            const root = roots[i];
            if (!new RegExp('--(tone-)?' + pl.tone + '(\\\\s|$)').test(root.className)) return pl.name + ' has classes ' + root.className;
            root.querySelectorAll('a[href], button:not(:disabled), input:not([type=hidden]):not(:disabled), textarea, select, summary').forEach((el, j) => {
              if (el.closest('.so-form__trap')) return;
              const role = el.matches('.so-btn--primary') ? 'primary' : el.matches('.so-btn--light') ? 'light' : el.matches('.so-btn--text') ? 'text' : 'control';
              label(el, pl.name + ' own ' + j + ' ' + (el.getAttribute('name') || el.textContent.trim().slice(0, 30) || el.tagName), role, pl.ownInk);
            });
            for (const spot of pl.spots) {
              const at = root.querySelector(spot.selector);
              if (!at) return pl.name + ' has no ' + spot.selector;
              const where = pl.name + ' ' + spot.selector;
              const box = document.createElement('div');
              box.innerHTML = spot.rich
                ? '<p><a class="so-link" href="#link">An inline link</a></p><ul class="so-rich--check"><li>A checked item</li></ul>'
                : '<a class="so-btn so-btn--primary" href="#primary">Primary</a> <a class="so-btn so-btn--text" href="#text">Read more</a> <a class="so-link" href="#link">A link</a><ul class="so-rich so-rich--check"><li>A checked item</li></ul>';
              at.append(box);
              box.querySelectorAll('.so-btn--primary').forEach((el) => label(el, where + ' primary', 'primary', spot.ink));
              box.querySelectorAll('.so-btn--text').forEach((el) => label(el, where + ' text button', 'text', spot.ink));
              // A rich-text link takes the text colour around it, which on a dark ground is the ground's own.
              box.querySelectorAll('.so-link').forEach((el) => label(el, where + ' link', 'link', spot.ink));
              box.querySelectorAll('li').forEach((el) => label(el, where + ' check', 'check', spot.ink));
            }
          }
          for (const [i, pl] of placements.entries()) {
            if (!pl.nestIn) continue;
            const host = roots[placements.findIndex((h) => h.name === pl.nestIn)];
            host.querySelector(${JSON.stringify(INNER)}).append(roots[i]);
          }
          return null;
        })(${JSON.stringify(PLACEMENTS)})`
      );
      expect(placed).toBeNull();
      // The footer is dark by default, and its links are faded.
      await label(p, 'footer a[href]', "label(el, 'footer link ' + i, 'control', 'on-inverse')");
      const { rest, hover } = await sampleAll(p);
      const colors = sites.sections.colors;
      expect(unoutlined(rest)).toEqual([]);
      for (const name of [...PLACEMENTS.map((pl) => pl.name), 'footer link']) expect(rest.some((s) => s.label.startsWith(name)), name).toBe(true);
      // The marks measured are drawn: a check mark and its 14% disc.
      for (const s of rest.filter((r) => r.check)) {
        expect(s.check!.content, s.label).not.toBe('none');
        expect(parseFloat(s.check!.width), s.label).toBeGreaterThanOrEqual(2);
        expect(rgba(s.check!.disc, s.label).a, s.label).toBeCloseTo(0.14, 2);
      }
      expect(wrongInk(rest, colors)).toEqual([]);
      expect(failures(rest)).toEqual([]);
      expect(failures(hover)).toEqual([]);
      // A filled button changes colour on hover, wherever it is.
      const resting = new Map(rest.map((s) => [s.id, s]));
      expect(hover.filter((h) => (h.role === 'primary' || h.role === 'light') && h.background === resting.get(h.id)!.background).map((h) => h.label)).toEqual([]);
      expect(rest.filter((s) => s.role === 'light').length).toBeGreaterThanOrEqual(3);
    });
  }, 180_000);

  // A dark section's own words, its supporting paragraph above all: muted on the light grounds, it has to lift on the
  // dark one (#1399), as the heading, questions and answers do.
  it('reads a dark section’s own text: its supporting paragraph, heading, questions and answers', async () => {
    await withPage('sections', 1280, async (p) => {
      const words = "[class*='__lead'], [class*='__eyebrow'], [class*='__heading'], [class*='__question'], [class*='__answer']";
      const labelled = (await p.evaluate(
        `((placements) => {
          const label = ${LABEL_FN};
          const roots = [...document.querySelectorAll('main > *')];
          const out = [];
          for (const [i, pl] of placements.entries()) {
            if (pl.tone !== 'inverse' || pl.nestIn) continue;
            roots[i].querySelectorAll(${JSON.stringify(words)}).forEach((el, j) => {
              if (!el.textContent.trim()) return;
              const name = pl.name + ' ' + [...el.classList].find((c) => /__(lead|eyebrow|heading|question|answer)$/.test(c));
              label(el, name + ' ' + j, 'text');
              out.push(name);
            });
          }
          return out;
        })(${JSON.stringify(PLACEMENTS)})`
      )) as string[];
      for (const part of ['lead', 'heading', 'question', 'answer']) expect(labelled, part).toContain(`faq.list inverse faq__${part}`);
      await settle(p);
      const ids = (await p.evaluate(`[...document.querySelectorAll('[data-role="text"][data-probe-id]')].map((el) => el.dataset.probeId)`)) as string[];
      const samples: Sample[] = [];
      for (const id of ids) samples.push(await sample(p, id));
      expect(samples.length).toBe(labelled.length);
      expect(failures(samples)).toEqual([]);
    });
  }, 60_000);

  it('shows a dark header’s action and links readably, and its current-page mark in the header’s text colour', async () => {
    await withPage('header-dark', 1280, async (p) => {
      await label(p, '.so-header__cta', "label(el, 'header action', 'primary', 'on-inverse')");
      await label(p, '.so-header__nav ul a', "label(el, 'header link ' + i, i ? 'link' : 'current', 'on-inverse')");
      await label(p, '.so-header__brand', "label(el, 'header brand', 'control', 'on-inverse')");
      // The first link's page as the current one, as the header marks it: on the link, and on its menu item.
      await p.evaluate(`(() => {
        const link = document.querySelector('.so-header__nav ul a');
        link.setAttribute('aria-current', 'page');
        link.closest('li').classList.add('so-header__item--current');
      })()`);
      const { rest, hover } = await sampleAll(p);
      const headerColor = (await p.evaluate(`getComputedStyle(document.querySelector('header.so-header')).color`)) as string;
      expect(rest.map((s) => s.label).sort()).toEqual(['header action', 'header brand', 'header link 0', 'header link 1']);
      const current = rest.find((s) => s.current)!.current!;
      expect(current.content).not.toBe('none');
      expect(parseFloat(current.height)).toBeGreaterThanOrEqual(2);
      expect(current.color).toBe(headerColor);
      expect(unoutlined(rest)).toEqual([]);
      // Header links fade to 72% of the header's text colour; their own colour is not the ink.
      expect(wrongInk(rest.filter((s) => s.role !== 'link'), sites['header-dark'].colors)).toEqual([]);
      expect(failures(rest)).toEqual([]);
      expect(failures(hover)).toEqual([]);
    });
  }, 60_000);

  for (const [name, why, background] of [
    ['header-custom', 'an author’s own dark background and light text', 'rgb(29, 43, 79)'],
    ['header-gradient', 'an author’s own gradient and light text', null],
    ['header-dark', 'the Dark background', null],
    ['header-default', 'the page background', null]
  ] as const) {
    it(`opens the phone menu in the header’s own colours, with ${why}`, async () => {
      await withPage(name, 390, async (p) => {
        await p.locator('.so-header__toggle').click();
        await p.locator('.so-header__nav').waitFor({ state: 'visible' });
        await settle(p);
        const paint = `(el) => { const cs = getComputedStyle(el); return [cs.backgroundColor, cs.backgroundImage, cs.color]; }`;
        const [headerColor, headerImage, headerText] = (await p.evaluate(`(${paint})(document.querySelector('header.so-header'))`)) as string[];
        const [navColor, navImage] = (await p.evaluate(`(${paint})(document.querySelector('.so-header__nav'))`)) as string[];
        if (background) expect([headerColor, headerText]).toEqual([background, 'rgb(255, 255, 255)']);
        expect([navColor, navImage]).toEqual([headerColor, headerImage]);
        if (name === 'header-gradient') return expect(navImage).toMatch(/^linear-gradient/);
        // The links' contrast is measured on an opaque header colour.
        expect(rgba(headerColor, name).a).toBe(1);
        await label(p, '.so-header__nav ul a', "label(el, 'menu link ' + i, 'menu')");
        const samples = (await p.evaluate(`[...document.querySelectorAll('[data-probe-id]')].map((el) => (${SAMPLE_FN})(el))`)) as Sample[];
        expect(samples.length).toBe(2);
        expect(failures(samples)).toEqual([]);
      });
    }, 60_000);
  }
});
