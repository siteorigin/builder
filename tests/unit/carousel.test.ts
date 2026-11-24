/**
 * The Carousel section (issue #381): a list of slides that scrolls sideways with CSS alone, and the runtime helper that
 * adds Previous and Next buttons and the count of the slides showing. Found in Insert and by the AI, placed and edited
 * through the ordinary operations, written into the site with its helper, and refused where it cannot work.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ComponentDefinition, ElementNode, InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { CATEGORY_LABELS, catalogueComponent, catalogueEntries, searchCatalogue } from '@catalogue/index';
import { FOUNDATION_EXAMPLES } from '@catalogue/foundation/ai-examples';
import { applyOperations } from '@engine/apply';
import { validateState } from '@engine/validate';
import { RUNTIME_DIR, defFile, generateProject } from '@generator/index';
import { CAROUSEL_JS, CAROUSEL_SVELTE } from '@generator/carousel';
import { isCarouselTrack } from '@generator/card-links';
import { pickImagesField } from '../../src/renderer/src/lib/gallery-picks';

interface Measured {
  rtl: boolean;
  at: number;
  size: number;
  max: number;
  slides: { start: number; size: number }[];
}
interface Shown {
  total: number;
  first: number;
  last: number;
  scrolls: boolean;
  back: boolean;
  forward: boolean;
}
interface Geometry {
  measure: (list: unknown) => Measured;
  view: (m: Measured) => Shown;
  status: (v: Shown) => string;
  step: (m: Measured, dir: number) => number | null;
}

/** A list `size` wide scrolled to `at`, of `n` slides `width` wide with `gap` between them. */
function laidOut(n: number, width: number, gap: number, size: number, at = 0): Measured {
  const slides = Array.from({ length: n }, (_, i) => ({ start: i * (width + gap), size: width }));
  const total = n ? n * width + (n - 1) * gap : 0;
  return { rtl: false, at, size, max: Math.max(0, total - size), slides };
}

describe('where a carousel is', () => {
  let dir: string;
  let g: Geometry;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'so-carousel-'));
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    writeFileSync(join(dir, 'carousel.js'), CAROUSEL_JS);
    g = await import(pathToFileURL(join(dir, 'carousel.js')).href);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => vi.unstubAllGlobals());

  it('steps a slide at a time through five slides three at a time, and stops where the last one shows', () => {
    // 1200px showing three 384px slides with 24px between them: the list stops at 0, 408 and 816.
    const at = (x: number) => laidOut(5, 384, 24, 1200, x);
    expect(g.view(at(0))).toEqual({ total: 5, first: 0, last: 2, scrolls: true, back: false, forward: true });
    expect(g.status(g.view(at(0)))).toBe('Slides 1–3 of 5');
    expect(g.step(at(0), 1)).toBe(408);
    expect(g.status(g.view(at(408)))).toBe('Slides 2–4 of 5');
    expect(g.step(at(408), 1)).toBe(816);
    const end = g.view(at(816));
    expect(end).toMatchObject({ first: 2, last: 4, back: true, forward: false });
    expect(g.status(end)).toBe('Slides 3–5 of 5');
    // Next does nothing at the end, though slides 4 and 5 start further on: no step leaves the count where it was.
    expect(g.step(at(816), 1)).toBeNull();
    expect(g.step(at(816), -1)).toBe(408);
    expect(g.step(at(408), -1)).toBe(0);
    expect(g.step(at(0), -1)).toBeNull();
  });

  it('counts one slide on a phone that shows the edge of the next', () => {
    // 342px showing 85% slides (290.7px) with 24px between them.
    const at = (x: number) => laidOut(4, 290.7, 24, 342, x);
    expect(g.status(g.view(at(0)))).toBe('Slide 1 of 4');
    expect(g.step(at(0), 1)).toBeCloseTo(314.7);
    expect(g.status(g.view(at(314.7)))).toBe('Slide 2 of 4');
    const last = at(at(0).max);
    expect(g.status(g.view(last))).toBe('Slide 4 of 4');
    expect(g.view(last).forward).toBe(false);
  });

  it('takes a pixel either way as rounding, not a slide', () => {
    const m = laidOut(5, 384, 24, 1200, 0.6);
    expect(g.view(m)).toMatchObject({ first: 0, last: 2, back: false, forward: true });
    expect(g.step(m, -1)).toBeNull();
    // Just short of a stop, the next step goes on to the one after it rather than nowhere.
    expect(g.step(laidOut(5, 384, 24, 1200, 407.5), 1)).toBe(816);
    expect(g.view(laidOut(5, 384, 24, 1200, 815.4))).toMatchObject({ forward: false, last: 4 });
  });

  it('jumps to the start and the end', () => {
    expect(g.step(laidOut(5, 384, 24, 1200, 408), -Infinity)).toBe(0);
    expect(g.step(laidOut(5, 384, 24, 1200, 408), Infinity)).toBe(816);
    expect(g.step(laidOut(5, 384, 24, 1200, 816), Infinity)).toBeNull();
  });

  it('says nothing, and goes nowhere, with no slides or when every slide fits', () => {
    expect(g.view(laidOut(0, 384, 24, 1200))).toEqual({ total: 0, first: 0, last: 0, scrolls: false, back: false, forward: false });
    expect(g.status(g.view(laidOut(0, 384, 24, 1200)))).toBe('');
    const fits = laidOut(2, 384, 24, 1200);
    expect(g.view(fits)).toMatchObject({ total: 2, first: 0, last: 1, scrolls: false, back: false, forward: false });
    expect(g.step(fits, 1)).toBeNull();
    expect(g.step(fits, -1)).toBeNull();
    const one = laidOut(1, 1200, 24, 1200);
    expect(g.status(g.view(one))).toBe('Slide 1 of 1');
  });

  it('counts the slide that shows most when none shows by half, as one wider than the list', () => {
    const wide = { rtl: false, at: 300, size: 400, max: 1600, slides: [{ start: 0, size: 1000 }, { start: 1000, size: 1000 }] };
    expect(g.view(wide)).toMatchObject({ first: 0, last: 0 });
  });

  /** A list measured on the page: its box and scroll, and its slides' boxes, as the browser reports them. */
  const fakeList = (direction: 'ltr' | 'rtl', scrollLeft: number) => {
    vi.stubGlobal('getComputedStyle', () => ({ direction }));
    // 600px wide at x 100, with a 2px border; three 200px slides with 20px between them, the last one 0 wide (hidden).
    const left = 102;
    const right = left + 600;
    const pos = (i: number) => i * 220;
    const box = (i: number, w = 200) => (direction === 'ltr' ? { left: left + pos(i) - scrollLeft, right: left + pos(i) - scrollLeft + w, width: w } : { left: right - pos(i) - scrollLeft - w, right: right - pos(i) - scrollLeft, width: w });
    return {
      clientLeft: 2,
      clientWidth: 600,
      scrollWidth: 640,
      scrollLeft,
      getBoundingClientRect: () => ({ left: 100, right: 704, width: 604 }),
      children: [{ getBoundingClientRect: () => box(0) }, { getBoundingClientRect: () => box(1) }, { getBoundingClientRect: () => box(2) }, { getBoundingClientRect: () => box(3, 0) }]
    };
  };

  it('measures from the side a list starts on, left to right or right to left', () => {
    for (const [direction, scrollLeft] of [
      ['ltr', 40],
      ['rtl', -40]
    ] as const) {
      const m = g.measure(fakeList(direction, scrollLeft));
      expect(m.rtl, direction).toBe(direction === 'rtl');
      expect(m.at, direction).toBe(40);
      expect(m.max, direction).toBe(40);
      expect(m.size, direction).toBe(600);
      // A slide with no width is not counted.
      expect(m.slides, direction).toEqual([
        { start: 0, size: 200 },
        { start: 220, size: 200 },
        { start: 440, size: 200 }
      ]);
    }
  });
});

describe('the carousel helper', () => {
  it('compiles for the browser and the server without warnings', () => {
    for (const generate of ['client', 'server'] as const) {
      const out = compile(CAROUSEL_SVELTE, { filename: 'Carousel.svelte', generate, runes: true });
      expect(out.warnings.map((w) => w.code)).toEqual([]);
    }
  });

  it('carries no editor code, and imports only its own geometry', () => {
    for (const source of [CAROUSEL_SVELTE, CAROUSEL_JS]) expect(source).not.toMatch(/data-so-|__siteorigin|siteorigin/i);
    expect([...CAROUSEL_SVELTE.matchAll(/import .* from '([^']+)'/g)].map((m) => m[1])).toEqual(['svelte', './carousel.js']);
    expect(CAROUSEL_JS).not.toMatch(/^import /m);
  });

  it('steps at once for a visitor who asks for reduced motion, asking at each step', () => {
    expect(CAROUSEL_SVELTE).toMatch(/function go\(dir\) \{[\s\S]*matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches[\s\S]*behavior: reduce \? 'instant' : 'smooth'/);
  });

  it('shows its buttons only once its script runs, and disables neither so focus stays on them at the ends', () => {
    expect(CAROUSEL_SVELTE).toMatch(/\{#if ready && shown\.scrolls && shown\.total\}/);
    expect(CAROUSEL_SVELTE).not.toMatch(/\sdisabled=/);
    expect(CAROUSEL_SVELTE).toMatch(/aria-disabled=\{!shown\.back\}/);
    expect(CAROUSEL_SVELTE).toMatch(/aria-disabled=\{!shown\.forward\}/);
  });

  it('prints every slide in a stack, without its buttons', () => {
    const print = CAROUSEL_SVELTE.slice(CAROUSEL_SVELTE.indexOf('@media print'));
    expect(print).toMatch(/\.so-carousel__list \{[^}]*display: grid !important;[^}]*overflow: visible !important;/);
    expect(print).toMatch(/\.so-carousel__list > :global\(\*\) \{\s*width: auto !important;/);
    expect(print).toMatch(/\.so-carousel__controls \{\s*display: none !important;/);
  });
});

describe('the Carousel section', () => {
  const fresh = () => createStarterState('business', 'Kloof', false);
  const contact = (s: ProjectState) => Object.values(s.pages).find((p) => p.route === '/contact/')!;
  const SLIDES = [
    { id: 's1', image: { assetId: null, alt: '' }, caption: 'Measuring the room', link: { type: 'none', target: '' } },
    { id: 's2', image: { assetId: null, alt: '' }, caption: 'Choosing the finishes', link: { type: 'url', target: 'https://example.com/finishes' } },
    { id: 's3', image: { assetId: null, alt: '' }, caption: '', link: { type: 'none', target: '' } }
  ];

  function placed(props: Record<string, unknown> = {}) {
    const s0 = fresh();
    const page = contact(s0);
    const owner = { kind: 'page' as const, id: page.id };
    const r = applyOperations(s0, [{ type: 'node.insert', owner, componentId: 'media.carousel', index: 1, ...(Object.keys(props).length ? { props } : {}) }]);
    const nodeId = r.results[0].nodeId as string;
    return { s: r.state, owner, nodeId, node: r.state.pages[page.id].nodes[nodeId] as InstanceNode };
  }

  it('is found in Insert by the words authors search for, under Media, in both themes', () => {
    const entry = catalogueEntries('foundation').find((e) => e.componentId === 'media.carousel')!;
    expect(entry).toBeDefined();
    expect(CATEGORY_LABELS[entry.category]).toBe('Media');
    expect(entry.axes.layout).toEqual(['default', 'two-columns', 'one-column']);
    for (const q of ['carousel', 'slider', 'slideshow', 'product tour', 'case study']) expect(searchCatalogue('foundation', q).map((e) => e.componentId), q).toContain('media.carousel');
    expect(catalogueEntries('foundation-alt').some((e) => e.componentId === 'media.carousel')).toBe(true);
  });

  it('starts empty, and takes several library images at once into its slides', () => {
    const { node } = placed();
    expect(node.props.slides).toEqual([]);
    const def = catalogueComponent('foundation', 'media.carousel')!;
    expect(pickImagesField(def, 'slides', def.properties.slides)).toBe('image');
    expect(pickImagesField(def, 'heading', def.properties.heading)).toBeNull();
  });

  it('keeps its slides, their links and how many show at once when edited and when the theme is switched', () => {
    const { s, owner, nodeId } = placed({ slides: SLIDES });
    const captioned = applyOperations(s, [{ type: 'instance.setProp', owner, nodeId, prop: 'slides', value: SLIDES.map((x, i) => (i === 2 ? { ...x, caption: 'Fitting day' } : x)) }]).state;
    const two = applyOperations(captioned, [{ type: 'instance.setVariant', owner, nodeId, axis: 'layout', variant: 'two-columns' }]).state;
    expect(() => applyOperations(two, [{ type: 'instance.setVariant', owner, nodeId, axis: 'layout', variant: 'four-columns' }])).toThrow();
    const alt = applyOperations(two, [{ type: 'theme.apply', themeId: 'foundation-alt' }]).state;
    const node = alt.pages[owner.id].nodes[nodeId] as InstanceNode;
    expect(alt.components[node.definitionId].provenance?.pack).toBe('foundation-alt');
    expect(node.variants?.layout).toBe('two-columns');
    expect((node.props.slides as { id: string; caption: string; link: { type: string } }[]).map((x) => [x.id, x.caption, x.link.type])).toEqual([
      ['s1', 'Measuring the room', 'none'],
      ['s2', 'Choosing the finishes', 'url'],
      ['s3', 'Fitting day', 'none']
    ]);
    expect(validateState(alt).filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('renders its list through the carousel helper, which the site carries beside the other helpers', () => {
    const { s, node } = placed({ slides: SLIDES });
    const def = s.components[node.definitionId];
    const clean = generateProject(s);
    expect(clean.get(`${RUNTIME_DIR}/Carousel.svelte`)).toBe(CAROUSEL_SVELTE);
    expect(clean.get(`${RUNTIME_DIR}/carousel.js`)).toBe(CAROUSEL_JS);
    const source = clean.get(defFile(def))!;
    expect(source).toContain('import SoCarousel from "../runtime/Carousel.svelte";');
    // The list keeps its own classes and is named by the heading; its slides repeat inside it, each one a list item.
    expect(source).toMatch(/<SoCarousel\s+class=\{[^}]*__track[^}]*\}\s+aria-label=\{has\(heading\) \? heading : undefined\}\s*>\s*\{#each[^}]*\}\s*<li\b/);
    expect(source).not.toContain('data-so-');
    // In the editor the list carries what finds it, and each slide its item.
    const dev = generateProject(s, { instrument: true }).get(defFile(def))!;
    expect(dev).toMatch(/<SoCarousel[^>]*data-so-node="track"/);
    expect(dev).toMatch(/<li[^>]*data-so-node="slide"[^>]*data-so-items=/);
  });

  it('has a worked example of slides with captions and a link, shown two at a time', () => {
    const example = FOUNDATION_EXAMPLES.find((e) => e.componentId === 'media.carousel')!;
    expect(example.keywords).toEqual(expect.arrayContaining(['carousel', 'slider', 'product tour']));
    expect(example.variants).toEqual({ layout: 'two-columns' });
    expect((example.props.slides as unknown[]).length).toBeGreaterThan(1);
  });
});

describe('what may be a carousel', () => {
  const track = (over: Partial<ElementNode> = {}): ElementNode => ({ id: 't', kind: 'element', tag: 'ul', children: [], carousel: true, ...over });

  it('is a plain bulleted list that is not itself a link', () => {
    expect(isCarouselTrack(track())).toBe(true);
    expect(isCarouselTrack(track({ tag: 'div' }))).toBe(false);
    expect(isCarouselTrack(track({ tag: { $prop: 'tag' } }))).toBe(false);
    expect(isCarouselTrack(track({ link: { type: 'url', target: 'https://example.com' } }))).toBe(false);
    expect(isCarouselTrack(track({ link: { type: 'none', target: '' } }))).toBe(true);
    expect(isCarouselTrack(track({ carousel: undefined }))).toBe(false);
  });

  /** The project's own copy of the Carousel, with its list changed by `change`. */
  function ownCopy(change: (nodes: ComponentDefinition['tree'] & object) => void): ProjectState {
    const s = createStarterState('business', 'Kloof', false);
    const theme = catalogueComponent('foundation', 'media.carousel')!;
    const def: ComponentDefinition = structuredClone({ ...theme, id: 'def_own_carousel', owner: 'project' as const, componentId: 'project.carousel' });
    change(def.tree!);
    s.components[def.id] = def;
    return s;
  }
  const carouselErrors = (s: ProjectState) => validateState(s).filter((d) => d.code === 'CAROUSEL_INVALID');

  it('reports a copy whose list became something else, or a link', () => {
    expect(carouselErrors(ownCopy(() => {}))).toEqual([]);
    const div = carouselErrors(ownCopy((t) => ((t.nodes.track as ElementNode).tag = 'div')));
    expect(div).toHaveLength(1);
    expect(div[0]).toMatchObject({ severity: 'error', nodeId: 'track' });
    expect(div[0].message).toMatch(/“Slides” is marked as a carousel, which only a bulleted list \(ul\) that is not itself a link can be/);
    expect(carouselErrors(ownCopy((t) => ((t.nodes.track as ElementNode).link = { type: 'url', target: 'https://example.com' })))).toHaveLength(1);
  });

  it('counts as a control inside a card, so a card around it is reported', () => {
    const unnamed = ownCopy((t) => {
      (t.nodes.inner as ElementNode).link = { type: 'url', target: 'https://example.com' };
      delete t.nodes.track.name;
    });
    expect(validateState(unnamed).filter((d) => d.code === 'CARD_LINK_INTERACTIVE' && d.nodeId === 'inner').map((d) => d.message)).toEqual([expect.stringMatching(/a carousel with Previous and Next buttons sits inside a card/)]);
    const s = ownCopy((t) => ((t.nodes.inner as ElementNode).link = { type: 'url', target: 'https://example.com' }));
    const cards = validateState(s).filter((d) => d.code === 'CARD_LINK_INTERACTIVE' && d.nodeId === 'inner');
    expect(cards.map((d) => d.message)).toEqual([expect.stringMatching(/the “Slides” element sits inside a card that links somewhere/)]);
  });
});
