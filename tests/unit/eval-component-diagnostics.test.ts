/**
 * The benchmark's static component measurer (#365): fixed widths wider than the screen and text without enough
 * contrast, from the design alone, with anything it cannot work out left unmeasured rather than passed.
 */
import { describe, expect, it } from 'vitest';
import type { ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { digestComponentInspection, inspectionSteps, planComponentInspection, resolveInspectTarget } from '@agent/component-inspection';
import { measureComponent, staticInspector, type StaticMeasurement } from '../../scripts/eval/component-diagnostics';

type Styles = Record<string, Record<string, unknown>>;

/** A panel holding a line of text, with the styles given, and a second line shown only while `extra` is on. */
function panel(panelStyles: Styles, lineStyles: Styles = {}): { state: ProjectState; id: string } {
  const state = createStarterState('business', 'Harbour Lane Studio', false);
  const made = applyOperations(state, [
    {
      type: 'component.upsert',
      name: 'Counter hours',
      properties: { message: { type: 'string', label: 'Message', default: 'Counter closes at four' }, extra: { type: 'boolean', label: 'Extra', default: false } },
      nodes: [
        { kind: 'element', id: 'panel', tag: 'aside', children: ['line', 'more'], styles: panelStyles },
        { kind: 'text', id: 'line', tag: 'p', text: { $prop: 'message' }, styles: lineStyles },
        { kind: 'text', id: 'more', tag: 'p', text: 'Hidden unless extra', when: { $prop: 'extra' }, styles: { base: { color: { token: 'color.surface' } } } }
      ]
    } as EditOperation
  ]);
  return { state: made.state, id: String(made.results[0].definitionId) };
}

const measure = (p: { state: ProjectState; id: string }, width: number, props?: Record<string, unknown>) => {
  const m = measureComponent(p.state, { definitionId: p.id, ...(props ? { props } : {}) }, width);
  if ('error' in m) throw new Error(m.error);
  return m;
};
const kinds = (m: StaticMeasurement) => m.findings.map((f) => `${f.kind}@${f.nodeId}`);
const BROKEN = { base: { width: '720px', background: { token: 'color.surface' } } };
const UNREADABLE = { base: { color: { token: 'color.text' } }, phone: { color: { token: 'color.surface' } } };

describe('static component measurement for the benchmark', () => {
  it('finds a fixed width wider than a phone and text the color of its panel there, and neither on desktop', () => {
    const p = panel(BROKEN, UNREADABLE);
    const phone = measure(p, 390);
    expect(kinds(phone)).toEqual(['element-overflow@panel', 'low-contrast@line']);
    expect(phone.findings[0].message).toContain('720px wide');
    expect(phone.texts).toEqual([{ nodeId: 'line', ratio: 1 }]);
    const desktop = measure(p, 1280);
    expect(desktop.findings).toEqual([]);
    expect(desktop.texts[0].ratio).toBeGreaterThan(15);
  });

  it('counts a width that fills, or a fixed one a maximum caps, as fitting; a minimum width wins over the cap', () => {
    expect(measure(panel({ ...BROKEN, phone: { width: 'fill' } }), 390).findings).toEqual([]);
    expect(measure(panel({ base: { width: '720px', maxWidth: '100%' } }), 390).findings).toEqual([]);
    expect(measure(panel({ base: { width: '45rem' } }), 390).findings.map((f) => f.kind)).toEqual(['element-overflow']);
    expect(kinds(measure(panel({ base: { minWidth: '720px', maxWidth: '100%' } }), 390))).toEqual(['element-overflow@panel']);
  });

  it('leaves a width or a color it cannot work out unmeasured, never passed', () => {
    const calc = measure(panel({ base: { width: 'calc(100% + 400px)' } }), 390);
    expect(calc.widths.unmeasured).toEqual(['panel']);
    expect(calc.findings).toEqual([]);
    // A picture behind the text: set straight on the design, as the library would hold the image.
    const pictured = panel({ base: { background: { token: 'color.surface' } } });
    (pictured.state.components[pictured.id].tree!.nodes.panel.styles as Styles).base.backgroundImage = { assetId: 'a1' };
    expect(measure(pictured, 390).texts).toEqual([{ nodeId: 'line', ratio: null }]);
  });

  it('measures only text that renders: not text a condition leaves out, nor text hidden at that size', () => {
    const p = panel({}, { phone: { hidden: true } });
    expect(measure(p, 390).texts).toEqual([]);
    expect(measure(p, 1280).texts.map((t) => t.nodeId)).toEqual(['line']);
    // Shown while extra is on, in the panel's own color.
    expect(kinds(measure(p, 1280, { extra: true }))).toEqual(['low-contrast@more']);
  });

  it('reads a see-through color over what is behind it', () => {
    const faint = measure(panel({ base: { background: { token: 'color.surface' } } }, { base: { color: { token: 'color.text', alpha: 0.2 } } }), 1280);
    expect(faint.texts[0].ratio).toBeLessThan(4.5);
    expect(kinds(faint)).toEqual(['low-contrast@line']);
  });

  it('answers inspect_component as the preview would, so its findings name the design nodes', async () => {
    const p = panel(BROKEN, UNREADABLE);
    const target = resolveInspectTarget(p.state, { definitionId: p.id });
    if ('error' in target) throw new Error(target.error);
    const cases = planComponentInspection(target);
    const window = cases.slice(0, 8);
    const results = await staticInspector(() => p.state)(inspectionSteps(target, window));
    expect(results.every((r) => r.state === 'ready')).toBe(true);
    const digest = digestComponentInspection(target, window, results, { offset: 0, total: cases.length, all: cases });
    expect(digest.measured).toBe(results.length);
    const findings = digest.content.findings as Array<{ kind: string; at?: { nodeId: string }; in: string[] }>;
    expect(findings.map((f) => `${f.kind}@${f.at?.nodeId}`)).toEqual(['element-overflow@panel', 'low-contrast@line']);
    expect(findings[0].in.join(' ')).toContain('phone');
    expect(findings[0].in.join(' ')).not.toContain('desktop');
    // A design that is not there cannot be measured, and says so.
    expect(await staticInspector(() => p.state)([{ spec: { definitionId: 'proj.gone' }, width: 390 }])).toEqual([{ state: 'error', error: 'There is no such component to measure.', width: 390 }]);
  });
});
