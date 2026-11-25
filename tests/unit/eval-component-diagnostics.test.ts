/**
 * The benchmark's static component measurer (#365): widths wider than the screen and text without enough contrast,
 * from the design alone, with anything it cannot work out left unmeasured rather than passed.
 */
import { describe, expect, it } from 'vitest';
import type { ComponentPreviewResult } from '@shared/component-preview';
import type { ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { digestComponentInspection, inspectionSteps, planComponentInspection, resolveInspectTarget } from '@agent/component-inspection';
import { measureComponent, staticInspector, type StaticMeasurement } from '../../scripts/eval/component-diagnostics';

type Styles = Record<string, Record<string, unknown>>;

/**
 * A panel holding a line of text, with the styles given; a second line, in the panel's own color, shown only while
 * `extra` is on; a 720px-wide box shown only while `wide` is on; and a Tone axis whose Ghost option paints the line in
 * the panel's color on phones.
 */
function panel(panelStyles: Styles, lineStyles: Styles = {}): { state: ProjectState; id: string } {
  const state = createStarterState('business', 'Harbour Lane Studio', false);
  const made = applyOperations(state, [
    {
      type: 'component.upsert',
      name: 'Counter hours',
      properties: {
        message: { type: 'string', label: 'Message', default: 'Counter closes at four' },
        extra: { type: 'boolean', label: 'Extra', default: false },
        wide: { type: 'boolean', label: 'Wide', default: false }
      },
      nodes: [
        { kind: 'element', id: 'panel', tag: 'aside', children: ['line', 'more', 'band'], styles: panelStyles },
        { kind: 'text', id: 'line', tag: 'p', text: { $prop: 'message' }, styles: lineStyles },
        { kind: 'text', id: 'more', tag: 'p', text: 'Hidden unless extra', when: { $prop: 'extra' }, styles: { base: { color: { token: 'color.surface' } } } },
        { kind: 'element', id: 'band', tag: 'div', children: [], when: { $prop: 'wide' }, styles: { base: { width: '720px' } } }
      ],
      variantAxes: { tone: { label: 'Tone', options: { plain: { label: 'Plain' }, ghost: { label: 'Ghost', styles: { line: { phone: { color: { token: 'color.surface' } } } } } } } }
    } as EditOperation
  ]);
  return { state: made.state, id: String(made.results[0].definitionId) };
}

const measure = (p: { state: ProjectState; id: string }, width: number, spec: { props?: Record<string, unknown>; variants?: Record<string, string> } = {}) => {
  const m = measureComponent(p.state, { definitionId: p.id, ...spec }, width);
  if ('error' in m) throw new Error(m.error);
  return m;
};
const kinds = (m: StaticMeasurement) => m.findings.map((f) => `${f.kind}@${f.nodeId}`);
const SURFACE = { background: { token: 'color.surface' } };
const BROKEN = { base: { width: '720px', ...SURFACE } };
const UNREADABLE = { base: { color: { token: 'color.text' } }, phone: { color: { token: 'color.surface' } } };
/** A style set straight on the design, as a hand-edited project might hold it. */
const handSet = (p: { state: ProjectState; id: string }, nodeId: string, styles: Record<string, unknown>) => Object.assign((p.state.components[p.id].tree!.nodes[nodeId].styles as Styles).base, styles);

describe('static component measurement for the benchmark', () => {
  it('finds a fixed width wider than a phone and text the color of its panel there, and neither on desktop', () => {
    const p = panel(BROKEN, UNREADABLE);
    const phone = measure(p, 390);
    // The line only fills the panel: the overflow is the panel's alone.
    expect(kinds(phone)).toEqual(['element-overflow@panel', 'low-contrast@line']);
    expect(phone.findings[0].message).toContain('720px wide');
    expect(phone.texts).toEqual([{ nodeId: 'line', ratio: 1 }]);
    expect(phone.boxes).toMatchObject({ panel: 720, line: 720 });
    const desktop = measure(p, 1280);
    expect(desktop.findings).toEqual([]);
    expect(desktop.texts[0].ratio).toBeGreaterThan(15);
    expect(desktop.boxes.panel).toBe(720);
  });

  it('measures the variant options it is asked for', () => {
    const p = panel({ base: SURFACE });
    expect(kinds(measure(p, 390))).toEqual([]);
    expect(kinds(measure(p, 390, { variants: { tone: 'ghost' } }))).toEqual(['low-contrast@line']);
    expect(kinds(measure(p, 1280, { variants: { tone: 'ghost' } }))).toEqual([]);
  });

  it('works out the width each element renders at: filling, capped, at least a minimum, in rem, % or vw', () => {
    const width = (styles: Styles, at = 390) => {
      const m = measure(panel(styles), at);
      return { box: m.boxes.panel, checked: m.widths.checked, unmeasured: m.widths.unmeasured, findings: kinds(m) };
    };
    // The panel and the line it holds are each measured.
    expect(width({ ...BROKEN, phone: { width: 'fill' } })).toEqual({ box: 390, checked: 2, unmeasured: [], findings: [] });
    expect(width({ base: { width: '720px', maxWidth: '100%' } })).toMatchObject({ box: 390, findings: [] });
    expect(width({ base: { width: 'fill', maxWidth: '720px' } }, 1280)).toMatchObject({ box: 720, findings: [] });
    // Capped, but still wider than the screen: the width it renders at is the cap.
    expect(width({ base: { width: '720px', maxWidth: '500px' } })).toMatchObject({ box: 500, findings: ['element-overflow@panel'] });
    expect(width({ base: { minWidth: '720px', maxWidth: '100%' } })).toMatchObject({ box: 720, findings: ['element-overflow@panel'] });
    expect(width({ base: { width: '45rem' } })).toMatchObject({ box: 720, findings: ['element-overflow@panel'] });
    expect(width({ base: { width: '120vw' } })).toMatchObject({ box: 468, findings: ['element-overflow@panel'] });
    expect(width({ base: { width: '50%' } })).toMatchObject({ box: 195, findings: [] });
    // Sized by its content: it wraps, so it fits, at a width only a browser knows.
    expect(width({ base: { width: 'fit' } })).toMatchObject({ box: undefined, checked: 2, unmeasured: [], findings: [] });
    // A minimum width of auto sets no floor.
    expect(width({ base: { width: '720px', minWidth: 'auto' } }, 1280)).toMatchObject({ box: 720, findings: [] });
    // Under a cap that cannot be worked out a width that fits still fits, but its own width is not known.
    expect(width({ base: { width: '720px', maxWidth: 'calc(100% - 1000px)' } }, 1280)).toEqual({ box: undefined, checked: 2, unmeasured: [], findings: [] });
  });

  it('works out a percentage from the container and a vw from the screen', () => {
    const inside = (lineStyles: Styles) => measure(panel({ base: { width: '200px' } }, lineStyles), 390);
    expect(inside({ base: { width: '50%' } }).boxes.line).toBe(100);
    const wide = inside({ base: { width: '110vw' } });
    expect(wide.boxes.line).toBeCloseTo(429);
    expect(kinds(wide)).toEqual(['element-overflow@line']);
  });

  it('finds items side by side in a row that need more room than it has, unless the row wraps', () => {
    const row = (wrap: boolean) => {
      const p = panel({ base: { layout: 'row', ...(wrap ? { wrap: true } : {}) } }, { base: { minWidth: '250px' } });
      Object.assign((p.state.components[p.id].tree!.nodes.band.styles as Styles).base, { width: 'fill', minWidth: '250px' });
      return measure(p, 390, { props: { wide: true } });
    };
    expect(kinds(row(false))).toEqual(['element-overflow@panel']);
    expect(row(false).findings[0].message).toContain('at least 500px');
    expect(kinds(row(true))).toEqual([]);
  });

  it('leaves a width or a color it cannot work out unmeasured, never passed', () => {
    const calc = measure(panel({ base: { width: 'calc(100% + 400px)' } }), 390);
    expect(calc.widths).toEqual({ checked: 1, unmeasured: ['panel'] });
    expect(calc.findings).toEqual([]);
    // An em is the element's own font size, and a cap that cannot be worked out may or may not hold a wide panel.
    expect(measure(panel({ base: { width: '20em' } }), 390).widths.unmeasured).toEqual(['panel']);
    expect(measure(panel({ base: { width: '720px', maxWidth: 'calc(100% - 2rem)' } }), 390).widths.unmeasured).toEqual(['panel']);
    expect(measure(panel({ base: { width: '200px', maxWidth: 'calc(100% - 2rem)' } }), 390).widths.unmeasured).toEqual([]);
    // Custom CSS can change anything: set for every size, and also when a size's own custom CSS wins the cascade there.
    expect(measure(panel({ base: { width: 'fill', customCss: 'width: 720px;' } }), 390).widths.unmeasured).toEqual(['panel']);
    expect(measure(panel({ base: { width: 'fill', customCss: 'width: 720px;' }, phone: { customCss: 'letter-spacing: 1px;' } }), 390).widths.unmeasured).toEqual(['panel']);
    expect(measure(panel({ base: SURFACE }, { phone: { customCss: 'display: none;' } }), 390).texts).toEqual([{ nodeId: 'line', ratio: null }]);
    // A picture behind the text, and text faded, in a box that can cut it off, or painted by custom CSS.
    const pictured = panel({ base: SURFACE });
    handSet(pictured, 'panel', { backgroundImage: { assetId: 'a1' } });
    expect(measure(pictured, 390).texts).toEqual([{ nodeId: 'line', ratio: null }]);
    expect(measure(panel({ base: SURFACE }, { base: { opacity: 0.2 } }), 390).texts).toEqual([{ nodeId: 'line', ratio: null }]);
    expect(measure(panel({ base: { ...SURFACE, opacity: 0.5 } }), 390).texts).toEqual([{ nodeId: 'line', ratio: null }]);
    expect(measure(panel({ base: { ...SURFACE, height: '40px', overflow: 'hidden' } }), 390).texts).toEqual([{ nodeId: 'line', ratio: null }]);
    expect(measure(panel({ base: SURFACE }, { base: { customCss: 'color: white;' } }), 390).texts).toEqual([{ nodeId: 'line', ratio: null }]);
  });

  it('reads an opaque background of its own over a picture, and a see-through color over what is behind it', () => {
    const p = panel({ base: SURFACE }, { base: { background: '#000000', color: '#ffffff' } });
    handSet(p, 'panel', { backgroundImage: { assetId: 'a1' } });
    expect(measure(p, 390).texts).toEqual([{ nodeId: 'line', ratio: 21 }]);
    const faint = measure(panel({ base: SURFACE }, { base: { color: { token: 'color.text', alpha: 0.2 } } }), 1280);
    expect(faint.texts[0].ratio).toBeGreaterThan(1.2);
    expect(faint.texts[0].ratio).toBeLessThan(2);
    expect(kinds(faint)).toEqual(['low-contrast@line']);
  });

  it('measures only what renders: not what a condition leaves out, nor what is hidden at that size, nor empty text', () => {
    // Hidden with the panel around it on phones.
    const p = panel({ base: SURFACE, phone: { hidden: true } });
    expect(measure(p, 390)).toMatchObject({ texts: [], widths: { checked: 0 } });
    expect(measure(p, 1280).texts.map((t) => t.nodeId)).toEqual(['line']);
    // The second line, in the panel's own color, while extra is on; the 720px box while wide is on.
    const q = panel({ base: SURFACE });
    expect(kinds(measure(q, 1280))).toEqual([]);
    expect(kinds(measure(q, 1280, { props: { extra: true } }))).toEqual(['low-contrast@more']);
    expect(kinds(measure(q, 390))).toEqual([]);
    expect(kinds(measure(q, 390, { props: { wide: true } }))).toEqual(['element-overflow@band']);
    // A line with no words shows nothing to read.
    expect(measure(panel({ base: SURFACE }, UNREADABLE), 390, { props: { message: '' } }).texts).toEqual([]);
  });

  it('answers inspect_component as the preview would, so its findings name the design nodes and a failed width shows', async () => {
    const p = panel(BROKEN, UNREADABLE);
    const target = resolveInspectTarget(p.state, { definitionId: p.id });
    if ('error' in target) throw new Error(target.error);
    const cases = planComponentInspection(target);
    const window = cases.slice(0, 8);
    const results = await staticInspector(() => p.state)(inspectionSteps(target, window));
    expect(results.every((r) => r.state === 'ready')).toBe(true);
    const checks = (r: ComponentPreviewResult) => (r.report as { checks: Record<string, { checked: number }> }).checks;
    // The panel and its line; the lines and box conditions leave out are not measured.
    expect(checks(results[0]).overflow).toEqual({ checked: 2, failed: 1 });
    expect(checks(results[0]).contrast).toEqual({ checked: 1, failed: 1, unverified: 0 });
    const digest = digestComponentInspection(target, window, results, { offset: 0, total: cases.length, all: cases });
    expect(digest.measured).toBe(results.length);
    const findings = digest.content.findings as Array<{ kind: string; at?: { nodeId: string }; in: string[] }>;
    expect(findings.map((f) => `${f.kind}@${f.at?.nodeId}`)).toEqual(['element-overflow@panel', 'low-contrast@line']);
    expect(findings[0].in.join(' ')).toContain('phone');
    expect(findings[0].in.join(' ')).not.toContain('desktop');
    // A width it cannot work out is reported beside what was found, so the measurement never reads as clean.
    const odd = panel({ base: { width: 'calc(100% + 400px)' } }, UNREADABLE);
    const oddTarget = resolveInspectTarget(odd.state, { definitionId: odd.id });
    if ('error' in oddTarget) throw new Error(oddTarget.error);
    const oddCases = planComponentInspection(oddTarget).slice(0, 1);
    const oddDigest = digestComponentInspection(oddTarget, oddCases, await staticInspector(() => odd.state)(inspectionSteps(oddTarget, oddCases)), { offset: 0, total: 1 });
    expect(oddDigest.measured).toBe(2);
    expect((oddDigest.content.findings as Array<{ kind: string }>).map((f) => f.kind)).toEqual(['low-contrast']);
    expect(JSON.stringify(oddDigest.content.runtimeErrors)).toContain('The width of \\"panel\\" could not be measured without a browser');
    expect(oddDigest.content.summary).not.toContain('no problems found');
    // A design that is not there cannot be measured, and says so.
    expect(await staticInspector(() => p.state)([{ spec: { definitionId: 'proj.gone' }, width: 390 }])).toEqual([{ state: 'error', error: 'There is no such component to measure.', width: 390 }]);
  });
});
