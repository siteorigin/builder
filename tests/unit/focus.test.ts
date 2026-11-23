import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstanceNode, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { cascadedStyle, coverCrop, cropAxis, describeFocus, focusFromPoint, formatFocus, parseFocus, parseRatio } from '@shared/focus';
import { MEDIA_QUERIES, partStyleControls, styleToCss, validateStyleValue } from '@shared/styles';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { generateComponentsCss, generateSiteCss, overrideClass } from '@generator/index';
import { componentDetail } from '@agent/context';
import { executeTool, type ToolHost } from '@agent/tools';
import { selectionTarget, selectionTools } from '@agent/selection';
import { ProjectSession } from '../../src/main/project/session';

const fresh = () => createStarterState('business', 'Focus Studio', false);
const pageOf = (s: ProjectState, title: string) => s.site.pageOrder.map((id) => s.pages[id]).find((p) => p.title === title)!;
const instanceOf = (s: ProjectState, title: string, componentId: string) => {
  const page = pageOf(s, title);
  return page.rootIds.map((id) => page.nodes[id] as InstanceNode).find((n) => s.components[n.definitionId]?.componentId === componentId)!;
};
const ownerOf = (s: ProjectState, title: string) => ({ kind: 'page' as const, id: pageOf(s, title).id });
const setStyle = (s: ProjectState, title: string, inst: InstanceNode, partId: string, scope: string, property: string, value: unknown): EditOperation =>
  ({ type: 'node.setStyle', owner: ownerOf(s, title), nodeId: inst.id, partId, scope, property, value }) as EditOperation;

/** The declarations of the rule for one selector inside one media query of a stylesheet. */
function ruleIn(css: string, media: string | null, selector: string): string | null {
  const body = media === null ? css.split('@media')[0] : (css.split(`@media ${media}`)[1] ?? '').split('@media')[0];
  const at = body.indexOf(`${selector} {`);
  if (at < 0) return null;
  return body.slice(at, body.indexOf('}', at) + 1);
}

describe('focal point values', () => {
  it('reads the keywords the style list offers and two percentages', () => {
    expect(parseFocus('center')).toEqual({ x: 50, y: 50 });
    expect(parseFocus('top')).toEqual({ x: 50, y: 0 });
    expect(parseFocus('right')).toEqual({ x: 100, y: 50 });
    expect(parseFocus('30% 20%')).toEqual({ x: 30, y: 20 });
    expect(parseFocus(' 12.5% 100% ')).toEqual({ x: 12.5, y: 100 });
  });

  it('refuses anything else', () => {
    for (const bad of ['150% 20%', '50%', '50% 20% 10%', '-10% 20%', '30px 20px', '12.55% 20%', 'left top', 'url(x) 1%', '', 'calc(50%) 20%'])
      expect(parseFocus(bad), bad).toBeNull();
    expect(parseFocus(50)).toBeNull();
  });

  it('stores a point clamped to the picture and rounded to a tenth', () => {
    expect(formatFocus({ x: 33.333, y: 66.666 })).toBe('33.3% 66.7%');
    expect(formatFocus({ x: -5, y: 140 })).toBe('0% 100%');
    expect(parseFocus(formatFocus({ x: 12.34, y: 0 }))).toEqual({ x: 12.3, y: 0 });
  });

  it('validates and writes object-position for a point, as it does for a keyword', () => {
    expect(validateStyleValue('objectPosition', '30% 20%')).toBeNull();
    expect(validateStyleValue('objectPosition', 'top')).toBeNull();
    expect(validateStyleValue('objectPosition', '130% 20%')).toMatch(/percentages/);
    expect(validateStyleValue('objectPosition', 'top; color: red')).not.toBeNull();
    expect(styleToCss('objectPosition', '30% 20%')).toEqual(['object-position: 30% 20%']);
    // A hand-edited document with a value outside the grammar writes nothing.
    expect(styleToCss('objectPosition', '30% 20%; display: none')).toEqual([]);
    expect(styleToCss('objectPosition', '999% 0%')).toEqual([]);
  });

  it('reads aspect ratios as width over height', () => {
    expect(parseRatio('16/9')).toBeCloseTo(16 / 9);
    expect(parseRatio('4 / 5')).toBeCloseTo(0.8);
    expect(parseRatio('1.5')).toBeCloseTo(1.5);
    expect(parseRatio('auto')).toBeNull();
    expect(parseRatio('0/1')).toBeNull();
  });

  it('names a point for screen readers', () => {
    expect(describeFocus({ x: 50, y: 50 })).toBe('Center');
    expect(describeFocus({ x: 30, y: 12.5 })).toBe('30% from the left, 12.5% from the top');
  });
});

describe('the crop a focal point gives', () => {
  it('moves a portrait up and down inside a landscape box', () => {
    // A 4:5 portrait in a 16:9 box keeps its full width and 45% of its height.
    expect(cropAxis(4 / 5, 16 / 9)).toBe('y');
    const center = coverCrop(4 / 5, 16 / 9, { x: 50, y: 50 });
    expect(center.w).toBe(1);
    expect(center.h).toBeCloseTo(0.45);
    expect(center.y).toBeCloseTo(0.275);
    expect(coverCrop(4 / 5, 16 / 9, { x: 50, y: 0 }).y).toBe(0);
    expect(coverCrop(4 / 5, 16 / 9, { x: 50, y: 100 }).y).toBeCloseTo(0.55);
    // Across makes no difference when nothing is cut from the sides.
    expect(coverCrop(4 / 5, 16 / 9, { x: 0, y: 20 })).toEqual(coverCrop(4 / 5, 16 / 9, { x: 100, y: 20 }));
  });

  it('moves a landscape photo sideways inside a square box', () => {
    expect(cropAxis(3 / 2, 1)).toBe('x');
    const crop = coverCrop(3 / 2, 1, { x: 25, y: 50 });
    expect(crop.h).toBe(1);
    expect(crop.w).toBeCloseTo(2 / 3);
    expect(crop.x).toBeCloseTo((1 / 3) * 0.25);
  });

  it('keeps a picked point inside the crop', () => {
    for (const [px, py] of [[0, 0], [0.1, 0.9], [0.5, 0.5], [1, 1], [0.73, 0.21]]) {
      const crop = coverCrop(4 / 5, 16 / 9, focusFromPoint(px, py));
      expect(py).toBeGreaterThanOrEqual(crop.y - 1e-9);
      expect(py).toBeLessThanOrEqual(crop.y + crop.h + 1e-9);
      const wide = coverCrop(3 / 2, 1, focusFromPoint(px, py));
      expect(px).toBeGreaterThanOrEqual(wide.x - 1e-9);
      expect(px).toBeLessThanOrEqual(wide.x + wide.w + 1e-9);
    }
  });

  it('calls a box of the picture’s own shape uncropped', () => {
    expect(cropAxis(1.5, 1.5)).toBeNull();
    expect(coverCrop(1.5, 1.5, { x: 10, y: 90 })).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe('where Image focus is offered', () => {
  it('adds it after the aspect ratio of every image part that can be cropped, in components a project already has', () => {
    const s = fresh();
    const def = (componentId: string) => Object.values(s.components).find((d) => d.componentId === componentId)!;
    // The stored list is what the issue saw: no focus control.
    expect(def('hero.split').parts.media.styleControls).toEqual(['aspectRatio', 'radius', 'shadow']);
    expect(partStyleControls(def('hero.split'), 'media')).toEqual(['aspectRatio', 'objectPosition', 'radius', 'shadow']);
    expect(partStyleControls(def('content.media'), 'media')).toContain('objectPosition');
    expect(partStyleControls(def('media.gallery'), 'image')).toEqual(['aspectRatio', 'objectPosition', 'radius']);
    expect(partStyleControls(def('team.grid'), 'portrait')).toEqual(['aspectRatio', 'objectPosition', 'radius']);
  });

  it('leaves other parts as they are', () => {
    const s = fresh();
    const hero = Object.values(s.components).find((d) => d.componentId === 'hero.split')!;
    expect(partStyleControls(hero, 'heading')).toEqual(hero.parts.heading.styleControls);
    expect(partStyleControls(hero, 'missing')).toBeUndefined();
    // An image part with no aspect ratio to crop to, or one that already offers focus, is unchanged.
    const media = { ...hero.parts.media, styleControls: ['radius'] };
    expect(partStyleControls({ ...hero, parts: { ...hero.parts, media } }, 'media')).toEqual(['radius']);
    const offered = { ...hero.parts.media, styleControls: ['objectPosition', 'aspectRatio'] };
    expect(partStyleControls({ ...hero, parts: { ...hero.parts, media: offered } }, 'media')).toEqual(['objectPosition', 'aspectRatio']);
  });

  it('tells the AI about the control and the grammar', async () => {
    const s = fresh();
    const hero = Object.values(s.components).find((d) => d.componentId === 'hero.split')!;
    expect(componentDetail(hero).parts.media.styleControls).toContain('objectPosition');
    const host = { state: () => s, revision: () => 1 } as unknown as ToolHost;
    const read = await executeTool('read_project', '{}', host, 'c1');
    const focus = (read.content as { styleProperties: string[] }).styleProperties.find((p) => p.startsWith('objectPosition'));
    expect(focus).toContain('"X% Y%"');
    const inst = instanceOf(s, 'Home', 'hero.split');
    const tools = selectionTools(s, selectionTarget({ owner: ownerOf(s, 'Home'), instancePath: [inst.id], nodeId: 'media', partId: 'media' }));
    expect(tools?.find((t) => t.name === 'style_selected_element')?.description).toContain('"X% Y%"');
  });
});

describe('the rules a crop is worked out from', () => {
  const placement = { phone: { objectPosition: '50% 10%' } };
  it('takes a stronger tier over a weaker one, whatever its screen size', () => {
    // A selected variant's all-sizes rule beats the design's phone rule: its selector is more specific.
    expect(cascadedStyle([[undefined], [{ base: { aspectRatio: '16/9' } }], [{ phone: { aspectRatio: '1/1' }, base: { aspectRatio: '4/5' } }]], 'phone', 'aspectRatio')).toBe('16/9');
    // The placement's own all-sizes value beats a variant's phone value.
    expect(cascadedStyle([[{ base: { aspectRatio: '3/2' } }], [{ phone: { aspectRatio: '16/9' } }]], 'phone', 'aspectRatio')).toBe('3/2');
  });

  it('within a tier, takes the size over all sizes and a later layer over an earlier one', () => {
    expect(cascadedStyle([[placement], [{ base: { objectPosition: 'top' } }]], 'phone', 'objectPosition')).toBe('50% 10%');
    expect(cascadedStyle([[placement], [{ base: { objectPosition: 'top' } }]], 'tablet', 'objectPosition')).toBe('top');
    expect(cascadedStyle([[{ base: { aspectRatio: '1/1' } }, { base: { aspectRatio: '3/2' } }]], 'desktop', 'aspectRatio')).toBe('3/2');
    expect(cascadedStyle([[{ phone: { aspectRatio: '1/1' } }, { base: { aspectRatio: '3/2' } }]], 'phone', 'aspectRatio')).toBe('1/1');
  });

  it('skips a value the export would drop', () => {
    const tiers = [[{ phone: { objectPosition: '50% 10%; color: red' } }], [{ base: { objectPosition: 'bottom' } }]];
    expect(cascadedStyle(tiers, 'phone', 'objectPosition', (v) => parseFocus(v) !== null)).toBe('bottom');
  });
});

describe('a focal point on one placement', () => {
  it('exports a portrait-to-landscape crop for phones on that hero only', () => {
    const s = fresh();
    const hero = instanceOf(s, 'Home', 'hero.split');
    const team = instanceOf(s, 'About', 'team.grid');
    const r = applyOperations(s, [setStyle(s, 'Home', hero, 'media', 'phone', 'aspectRatio', '16/9'), setStyle(s, 'Home', hero, 'media', 'phone', 'objectPosition', '50% 20%')]);
    const heroAfter = instanceOf(r.state, 'Home', 'hero.split');
    expect(heroAfter.overrides?.media).toEqual({ phone: { aspectRatio: '16/9', objectPosition: '50% 20%' } });
    const css = generateSiteCss(r.state);
    const cls = overrideClass(hero.id, 'media');
    const phone = ruleIn(css, MEDIA_QUERIES.phone, `.${cls}.${cls}`);
    expect(phone).toContain('object-position: 50% 20%');
    expect(phone).toContain('aspect-ratio: 16/9');
    // Not at the other sizes, not on the team portraits, and not in the shared design.
    expect(ruleIn(css, null, `.${cls}.${cls}`) ?? '').not.toContain('object-position');
    expect(css.match(/object-position/g)).toHaveLength(1);
    expect(instanceOf(r.state, 'About', 'team.grid').overrides).toEqual(team.overrides);
    expect(generateComponentsCss(r.state)).toBe(generateComponentsCss(s));
  });

  it('exports a landscape-to-square crop for tablets', () => {
    const s = fresh();
    const media = instanceOf(s, 'Home', 'content.media');
    const r = applyOperations(s, [setStyle(s, 'Home', media, 'media', 'tablet', 'aspectRatio', '1/1'), setStyle(s, 'Home', media, 'media', 'tablet', 'objectPosition', '20% 50%')]);
    const cls = overrideClass(media.id, 'media');
    const tablet = ruleIn(generateSiteCss(r.state), MEDIA_QUERIES.tablet, `.${cls}.${cls}`);
    expect(tablet).toContain('aspect-ratio: 1/1');
    expect(tablet).toContain('object-position: 20% 50%');
    // The About page's own media section is another placement of the same component.
    const about = instanceOf(r.state, 'About', 'content.media');
    expect(about.overrides?.media).toBeUndefined();
  });

  it('refuses a focal point outside the picture', () => {
    const s = fresh();
    const hero = instanceOf(s, 'Home', 'hero.split');
    expect(() => applyOperations(s, [setStyle(s, 'Home', hero, 'media', 'phone', 'objectPosition', '120% 20%')])).toThrow(/Image focus/);
  });
});

describe('undoing a focal point', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('takes back one drag at a time and rewrites the exported stylesheet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-focus-'));
    dirs.push(dir);
    const session = await ProjectSession.create(dir, fresh());
    const hero = instanceOf(session.state, 'Home', 'hero.split');
    const siteCss = () => readFileSync(join(dir, 'src/lib/siteorigin/styles/site.css'), 'utf8');
    const media = () => instanceOf(session.state, 'Home', 'hero.split').overrides?.media;
    await session.apply({ operations: [setStyle(session.state, 'Home', hero, 'media', 'phone', 'aspectRatio', '16/9')] }, { label: 'Style Image' });
    // Two drags in quick succession, each committed on release with no history key (as the inspector sends them).
    for (const y of [30, 20]) {
      const r = await session.apply({ operations: [setStyle(session.state, 'Home', hero, 'media', 'phone', 'objectPosition', `50% ${y}%`)], expectedRevision: session.revision }, { label: 'Style Image' });
      expect(r.ok).toBe(true);
    }
    expect(siteCss()).toContain('object-position: 50% 20%');
    await session.undo();
    expect(media()).toEqual({ phone: { aspectRatio: '16/9', objectPosition: '50% 30%' } });
    expect(siteCss()).toContain('object-position: 50% 30%');
    await session.undo();
    expect(media()).toEqual({ phone: { aspectRatio: '16/9' } });
    expect(siteCss()).not.toContain('object-position');
    expect(siteCss()).toContain('aspect-ratio: 16/9');
    // A drag started before an Undo is refused when it lands: it was planned against a project that moved on.
    const stale = await session.apply({ operations: [setStyle(session.state, 'Home', hero, 'media', 'phone', 'objectPosition', '50% 90%')], expectedRevision: session.revision - 1 }, { label: 'Style Image' });
    expect(stale.ok).toBe(false);
    expect(media()).toEqual({ phone: { aspectRatio: '16/9' } });
    await session.redo();
    expect(siteCss()).toContain('object-position: 50% 30%');
    await session.close();
  });
});
