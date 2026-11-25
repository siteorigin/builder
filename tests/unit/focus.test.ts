import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstanceNode, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { FocusCommits, cascadedStyle, coverCrop, cropAxis, describeFocus, focusFromPoint, formatFocus, parseFocus, parseRatio, type FocusState } from '@shared/focus';
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

/** The rules outside any media query (null), or inside one media query, of a stylesheet. */
const blockOf = (css: string, media: string | null) => (media === null ? css.split('@media')[0] : (css.split(`@media ${media}`)[1] ?? '').split('@media')[0]);

/** The declarations of the rule whose whole selector is `selector`, inside one media query (or none). */
function ruleIn(css: string, media: string | null, selector: string): string {
  const body = blockOf(css, media);
  const m = new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(body);
  if (!m) throw new Error(`no rule for ${selector} in ${media ?? 'the base block'}`);
  return m[1];
}

describe('focal point values', () => {
  it('reads the keywords the style list offers and two percentages', () => {
    expect(parseFocus('center')).toEqual({ x: 50, y: 50 });
    expect(parseFocus('top')).toEqual({ x: 50, y: 0 });
    expect(parseFocus('right')).toEqual({ x: 100, y: 50 });
    expect(parseFocus('bottom')).toEqual({ x: 50, y: 100 });
    expect(parseFocus('left')).toEqual({ x: 0, y: 50 });
    expect(parseFocus('30% 20%')).toEqual({ x: 30, y: 20 });
    expect(parseFocus(' 12.5% 100% ')).toEqual({ x: 12.5, y: 100 });
    // Any CSS whitespace separates them.
    expect(parseFocus('12.5%\t100%')).toEqual({ x: 12.5, y: 100 });
    expect(parseFocus('12.5%\n 100%')).toEqual({ x: 12.5, y: 100 });
  });

  it('refuses anything else', () => {
    for (const bad of ['150% 20%', '50% 150%', '50% 100.1%', '50%', '50% 20% 10%', '-10% 20%', '30px 20px', '12.55% 20%', 'left top', 'url(x) 1%', '', 'calc(50%) 20%'])
      expect(parseFocus(bad), bad).toBeNull();
    // Names an object inherits are not keywords, and a no-break space is not CSS whitespace.
    for (const bad of ['constructor', 'toString', '__proto__', 'hasOwnProperty', '50%\u00A020%']) expect(parseFocus(bad), bad).toBeNull();
    expect(parseFocus(50)).toBeNull();
  });

  it('stores a point clamped to the picture and rounded to a tenth', () => {
    expect(formatFocus({ x: 33.333, y: 66.666 })).toBe('33.3% 66.7%');
    expect(formatFocus({ x: -5, y: 140 })).toBe('0% 100%');
    expect(formatFocus({ x: 140, y: -5 })).toBe('100% 0%');
    expect(parseFocus(formatFocus({ x: 12.34, y: 0 }))).toEqual({ x: 12.3, y: 0 });
  });

  it('validates and writes object-position for a point, as it does for a keyword', () => {
    expect(validateStyleValue('objectPosition', '30% 20%')).toBeNull();
    expect(validateStyleValue('objectPosition', 'top')).toBeNull();
    expect(validateStyleValue('objectPosition', '130% 20%')).toMatch(/percentages/);
    expect(validateStyleValue('objectPosition', 'top; color: red')).not.toBeNull();
    expect(styleToCss('objectPosition', '30% 20%')).toEqual(['object-position: 30% 20%']);
    expect(styleToCss('objectPosition', 'top')).toEqual(['object-position: top']);
    for (const bad of ['constructor', '50%\u00A020%']) {
      expect(validateStyleValue('objectPosition', bad), bad).not.toBeNull();
      expect(styleToCss('objectPosition', bad), bad).toEqual([]);
    }
    expect(validateStyleValue('objectPosition', { token: 'space.lg' })).not.toBeNull();
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
    expect(parseRatio('1/0')).toBeNull();
  });

  it('names a point for screen readers', () => {
    expect(describeFocus({ x: 50, y: 50 })).toBe('Center');
    expect(describeFocus({ x: 30, y: 12.5 })).toBe('30% from the left, 12.5% from the top');
    expect(describeFocus({ x: 30.04, y: -2 })).toBe('30% from the left, 0% from the top');
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
    expect(coverCrop(4 / 5, 16 / 9, { x: 50, y: 20 }).y).toBeCloseTo(0.11);
    expect(coverCrop(4 / 5, 16 / 9, { x: 50, y: 12.5 }).y).toBeCloseTo(0.55 * 0.125);
    // Across makes no difference when nothing is cut from the sides.
    expect(coverCrop(4 / 5, 16 / 9, { x: 0, y: 20 })).toEqual(coverCrop(4 / 5, 16 / 9, { x: 100, y: 20 }));
  });

  it('moves a landscape photo sideways inside a square box', () => {
    expect(cropAxis(3 / 2, 1)).toBe('x');
    const crop = coverCrop(3 / 2, 1, { x: 25, y: 50 });
    expect(crop.h).toBe(1);
    expect(crop.w).toBeCloseTo(2 / 3);
    expect(crop.x).toBeCloseTo((1 / 3) * 0.25);
    // A 16:9 photo in a square keeps 56.25% of its width; at 80% across the crop starts 35% in.
    const wide = coverCrop(16 / 9, 1, { x: 80, y: 0 });
    expect(wide.w).toBeCloseTo(0.5625);
    expect(wide.x).toBeCloseTo(0.35);
    expect(wide.y).toBe(0);
  });

  it('keeps a picked point inside the crop', () => {
    // To within the tenth of a percent a point is stored to.
    for (const [px, py] of [[0, 0], [0.1, 0.9], [0.5, 0.5], [1, 1], [0.73, 0.21], [0.12345, 0.98765], [0.00051, 0.99949]]) {
      const crop = coverCrop(4 / 5, 16 / 9, focusFromPoint(px, py));
      expect(py).toBeGreaterThanOrEqual(crop.y - 1e-3);
      expect(py).toBeLessThanOrEqual(crop.y + crop.h + 1e-3);
      const wide = coverCrop(3 / 2, 1, focusFromPoint(px, py));
      expect(px).toBeGreaterThanOrEqual(wide.x - 1e-3);
      expect(px).toBeLessThanOrEqual(wide.x + wide.w + 1e-3);
    }
    expect(focusFromPoint(0.12345, 0.98765)).toEqual({ x: 12.3, y: 98.8 });
  });

  it('calls a box of the picture’s own shape uncropped', () => {
    expect(cropAxis(1.5, 1.5)).toBeNull();
    // Within half a percent of the picture's shape counts as uncropped; beyond it, the crop shows.
    expect(cropAxis(1.5, 1.5 * 1.004)).toBeNull();
    expect(cropAxis(1.5, 1.5 / 1.004)).toBeNull();
    expect(cropAxis(1.5, 1.5 * 1.01)).toBe('y');
    expect(cropAxis(1.5, 1.5 / 1.01)).toBe('x');
    expect(coverCrop(1.5, 1.5, { x: 10, y: 90 })).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe('sending focal point changes one after another', () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('builds a typed coordinate on what the project holds once a refused drag has answered', async () => {
    // The project holds 20% 30% at revision 5. A drag to 80% 90% goes out while an Undo is ahead of it.
    let project: FocusState = { point: { x: 20, y: 30 }, revision: 5 };
    const commits = new FocusCommits(() => project);
    const sent: Array<[string, number | undefined]> = [];
    let answerDrag!: (r: unknown) => void;
    const drag = commits.send(
      () => '80% 90%',
      (text, rev) => {
        sent.push([text, rev]);
        return new Promise((r) => (answerDrag = r));
      },
      5
    );
    // Down is typed before the drag has an answer.
    const down = commits.send(
      (base) => formatFocus({ ...base, y: 60 }),
      (text, rev) => {
        sent.push([text, rev]);
        return { revision: 7 };
      },
      'base'
    );
    await settle();
    expect(sent).toEqual([['80% 90%', 5]]);
    // The Undo lands, and the project refuses the drag planned before it.
    project = { point: { x: 20, y: 30 }, revision: 6 };
    answerDrag(null);
    expect(await drag).toEqual({ text: '80% 90%', made: undefined });
    // Down keeps the saved Across, not the refused drag's, and applies only where it was built.
    expect(await down).toEqual({ text: '20% 60%', made: 7 });
    expect(sent[1]).toEqual(['20% 60%', 6]);
  });

  it('builds on an accepted change before its snapshot arrives, and applies at the revision it made', async () => {
    const project: FocusState = { point: { x: 50, y: 50 }, revision: 3 };
    const commits = new FocusCommits(() => project);
    const sent: Array<[string, number | undefined]> = [];
    const apply = (made: number) => (text: string, rev?: number) => (sent.push([text, rev]), { revision: made });
    await commits.send((b) => formatFocus({ ...b, x: 20 }), apply(4), 'base');
    // The snapshot is still at 3: Down builds on the accepted Across, at the revision Across made.
    await commits.send((b) => formatFocus({ ...b, y: 75 }), apply(5), 'base');
    expect(sent).toEqual([['20% 50%', 3], ['20% 75%', 4]]);
    // An unrelated change landing first doesn't end it; the snapshot reaching it does.
    project.revision = 4;
    expect(commits.base()).toEqual({ point: { x: 20, y: 75 }, revision: 5 });
    Object.assign(project, { point: { x: 20, y: 75 }, revision: 5 });
    expect(commits.base()).toEqual(project);
    // A drag goes at its own revision, and Center as it is.
    await commits.send(() => '10% 10%', apply(6), 5);
    await commits.send(() => formatFocus({ x: 50, y: 50 }), apply(7));
    expect(sent.slice(2)).toEqual([['10% 10%', 5], ['50% 50%', undefined]]);
  });

  it('sends at once when nothing is on its way, so a typed edit keeps the context it was made in', () => {
    const commits = new FocusCommits(() => ({ point: { x: 50, y: 50 }, revision: 2 }));
    const sent: string[] = [];
    void commits.send((b) => formatFocus({ ...b, x: 10 }), (text) => (sent.push(text), new Promise(() => undefined)), 'base');
    expect(sent).toEqual(['10% 50%']);
    // The next waits for that one's answer.
    void commits.send(() => '20% 20%', (text) => sent.push(text));
    expect(sent).toEqual(['10% 50%']);
  });

  it('sends nothing still queued once the editor has moved on to another element or size', async () => {
    let here = true;
    const commits = new FocusCommits(() => (here ? { point: { x: 50, y: 50 }, revision: 1 } : null));
    const sent: string[] = [];
    let answer!: (r: unknown) => void;
    void commits.send(() => '10% 10%', (text) => (sent.push(text), new Promise((r) => (answer = r))));
    const queued = commits.send((b) => formatFocus({ ...b, y: 90 }), (text) => sent.push(text), 'base');
    here = false;
    answer({ revision: 2 });
    expect(await queued).toEqual({ text: '', made: undefined });
    expect(sent).toEqual(['10% 10%']);
  });

  it('treats a failed send as refused, and carries on with the next', async () => {
    const project: FocusState = { point: { x: 50, y: 50 }, revision: 1 };
    const commits = new FocusCommits(() => project);
    expect(await commits.send(() => '1% 1%', () => Promise.reject(new Error('closed')))).toEqual({ text: '1% 1%', made: undefined });
    expect(commits.base()).toEqual(project);
    expect(await commits.send(() => '30% 30%', () => ({ revision: 2 }))).toEqual({ text: '30% 30%', made: 2 });
    expect(commits.base()?.point).toEqual({ x: 30, y: 30 });
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
    const listed = (read.content as { styleProperties: string[] }).styleProperties;
    const focus = listed.find((p) => p.startsWith('objectPosition'));
    expect(focus).toContain('"X% Y%"');
    // Transforms and transitions say their range and unit (#351).
    expect(listed).toEqual(expect.arrayContaining(['rotate (-360 to 360 deg)', 'scale (0 to 3)', 'transitionDuration (whole number 0 to 3000 ms)']));
    expect(listed.find((p) => p.startsWith('translateY '))).toContain('500px, 32rem or em, or 100%');
    expect(listed.find((p) => p.startsWith('transition '))).toContain('[none|colors|shadow|transform|opacity|common]');
    expect(listed.find((p) => p.startsWith('opacity'))).toBe('opacity');
    // Frosted glass: a blur and its limit, and a color token at part strength (#353).
    expect(listed.find((p) => p.startsWith('backdropBlur '))).toBe('backdropBlur [0|4px|12px|24px] or one length in px, rem or em up to 64px or 4rem, 0 for none: blurs what shows through a background at less than full strength, for frosted glass');
    for (const id of ['background ', 'color ']) expect(listed.find((p) => p.startsWith(id)), id).toContain('{"token": "color.surface", "alpha": 0.7}');
    const inst = instanceOf(s, 'Home', 'hero.split');
    const tools = selectionTools(s, selectionTarget({ owner: ownerOf(s, 'Home'), instancePath: [inst.id], nodeId: 'media', partId: 'media' }));
    const style = tools?.find((t) => t.name === 'style_selected_element');
    expect(style?.description).toContain('"X% Y%"');
    expect(JSON.stringify(style?.parameters)).toContain('"objectPosition"');
  });

  it('tells the AI about custom column sizes, card widths and row spans (#352)', async () => {
    const s = fresh();
    const host = { state: () => s, revision: () => 1 } as unknown as ToolHost;
    const listed = ((await executeTool('read_project', '{}', host, 'c1')).content as { styleProperties: string[] }).styleProperties;
    const template = listed.find((p) => p.startsWith('gridTemplate '))!;
    // The presets are still listed, then the grammar beyond them.
    expect(template).toContain('[1fr 1fr|1fr 2fr|');
    for (const part of ['up to 12 column sizes', '"16rem 1fr 14rem"', '"repeat(auto-fit, minmax(18rem, 1fr))"', 'auto-fill', 'scope phone']) expect(template).toContain(part);
    expect(listed.find((p) => p.startsWith('rowSpan '))).toBe('rowSpan [1|2|3|4|5|6] (a grid child; above 1 for all sizes it applies from tablet up, set it at scope phone to span there)');
    expect(listed.find((p) => p.startsWith('columnSpan '))).toContain('scope phone');
    const inst = instanceOf(s, 'Home', 'hero.split');
    const tools = selectionTools(s, selectionTarget({ owner: ownerOf(s, 'Home'), instancePath: [inst.id], nodeId: 'media', partId: 'media' }));
    const style = tools?.find((t) => t.name === 'style_selected_element');
    for (const part of ['repeat(auto-fit, minmax(18rem, 1fr))', 'rowSpan (1 to 6)', 'apply from tablet up, so phones keep their own columns unless scope "phone" sets them']) expect(style?.description).toContain(part);
    expect(JSON.stringify(style?.parameters)).toContain('"rowSpan"');
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
    // Two layers with rules for the size: the later one wins, as two selected variant axes do.
    expect(cascadedStyle([[{ phone: { aspectRatio: '1/1' } }, { phone: { aspectRatio: '3/2' } }]], 'phone', 'aspectRatio')).toBe('3/2');
    // One layer with both: the size's rule wins.
    expect(cascadedStyle([[{ base: { aspectRatio: '1/1' }, phone: { aspectRatio: '3/2' } }]], 'phone', 'aspectRatio')).toBe('3/2');
    expect(cascadedStyle([[{ base: { aspectRatio: '1/1' }, phone: { aspectRatio: '3/2' } }]], 'desktop', 'aspectRatio')).toBe('1/1');
    expect(cascadedStyle([[undefined]], 'phone', 'aspectRatio')).toBeUndefined();
  });

  it('skips a value the export would drop', () => {
    const tiers = [[{ phone: { objectPosition: '50% 10%; color: red' } }], [{ base: { objectPosition: 'bottom' } }]];
    expect(cascadedStyle(tiers, 'phone', 'objectPosition', (v) => parseFocus(v) !== null)).toBe('bottom');
    const base = [[{ base: { objectPosition: 'constructor' } }], [{ base: { objectPosition: 'top' } }]];
    expect(cascadedStyle(base, 'desktop', 'objectPosition', (v) => parseFocus(v) !== null)).toBe('top');
    expect(cascadedStyle(base, 'desktop', 'objectPosition')).toBe('constructor');
  });
});

describe('a focal point on one placement', () => {
  it('exports a portrait-to-landscape crop for phones on that hero only', () => {
    // A second split hero on About: another placement of the same component.
    const start = fresh();
    const s = applyOperations(start, [{ type: 'node.insert', owner: ownerOf(start, 'About'), parentId: null, componentId: 'hero.split' }]).state;
    const hero = instanceOf(s, 'Home', 'hero.split');
    const otherHero = instanceOf(s, 'About', 'hero.split');
    const team = instanceOf(s, 'About', 'team.grid');
    expect(otherHero.definitionId).toBe(hero.definitionId);
    const r = applyOperations(s, [setStyle(s, 'Home', hero, 'media', 'phone', 'aspectRatio', '16/9'), setStyle(s, 'Home', hero, 'media', 'phone', 'objectPosition', '50% 20%')]);
    expect(instanceOf(r.state, 'Home', 'hero.split').overrides?.media).toEqual({ phone: { aspectRatio: '16/9', objectPosition: '50% 20%' } });
    const css = generateSiteCss(r.state);
    const cls = overrideClass(hero.id, 'media');
    const phone = ruleIn(css, MEDIA_QUERIES.phone, `.${cls}.${cls}`);
    expect(phone).toContain('object-position: 50% 20%');
    expect(phone).toContain('aspect-ratio: 16/9');
    // Not at the other sizes, not on the other hero or the team portraits, and not in the shared design.
    for (const media of [null, MEDIA_QUERIES.tablet, MEDIA_QUERIES.desktop]) expect(blockOf(css, media)).not.toContain('object-position');
    expect(css.match(/object-position/g)).toHaveLength(1);
    expect(css).not.toContain(overrideClass(otherHero.id, 'media'));
    expect(instanceOf(r.state, 'About', 'hero.split').overrides).toEqual(otherHero.overrides);
    expect(instanceOf(r.state, 'About', 'team.grid').overrides).toEqual(team.overrides);
    expect(generateComponentsCss(r.state)).toBe(generateComponentsCss(s));
  });

  it('exports a landscape-to-square crop for tablets', () => {
    const s = fresh();
    const media = instanceOf(s, 'Home', 'content.media');
    const r = applyOperations(s, [setStyle(s, 'Home', media, 'media', 'tablet', 'aspectRatio', '1/1'), setStyle(s, 'Home', media, 'media', 'tablet', 'objectPosition', '20% 50%')]);
    const cls = overrideClass(media.id, 'media');
    const css = generateSiteCss(r.state);
    const tablet = ruleIn(css, MEDIA_QUERIES.tablet, `.${cls}.${cls}`);
    expect(tablet).toContain('aspect-ratio: 1/1');
    expect(tablet).toContain('object-position: 20% 50%');
    for (const media of [null, MEDIA_QUERIES.phone, MEDIA_QUERIES.desktop]) expect(blockOf(css, media)).not.toContain('object-position');
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
