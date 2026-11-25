/**
 * inspect_layout narrowed to chosen elements (#743): the refs its findings name are sent back, checked against the
 * page, measured on their own, and never stand in for a check of the whole page.
 */
import { describe, expect, it } from 'vitest';
import type { ElementRef, InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { executeTool, type ToolHost } from '@agent/tools';
import { InspectionLog } from '@agent/report';
import { narrowedInspection, resolveLayoutTargets } from '@agent/layout-targets';
import { descOf, inspectionRef } from '../../src/renderer/src/lib/model';

const fresh = () => createStarterState('business', 'Test Studio', false);
const homeOf = (s: ProjectState) => s.pages[s.site.homePageId];
const placementOf = (s: ProjectState, definitionId: string) => Object.values(homeOf(s).nodes).find((n): n is InstanceNode => n.kind === 'instance' && n.definitionId === definitionId)!;
const ctxOf = (s: ProjectState, ...path: string[]) => [`page:${s.site.homePageId}`, ...path].join('|');

/** A host whose preview answers each element asked for as `answer` says, recording what it was asked. */
function hostFor(s: ProjectState, answer: (targets: ElementRef[] | undefined) => unknown) {
  const asked: Array<{ pageId: string; width: number; targets?: ElementRef[] }> = [];
  const host = {
    state: () => s,
    revision: () => 7,
    inspectLayout: async (pageId: string, width: number, targets?: ElementRef[]) => {
      asked.push({ pageId, width, ...(targets ? { targets } : {}) });
      return answer(targets);
    }
  } as unknown as ToolHost;
  return { host, asked };
}

const measuredBox = { box: { x: 0, y: 80, width: 390, height: 420 }, scrollWidth: 390, scrollHeight: 420, visible: true };

describe('inspect_layout with refs', () => {
  it('measures only the elements its findings named, each with its box, and reports one that does not show at that width as hidden', async () => {
    const s = fresh();
    const grid = placementOf(s, 'foundation.features.grid');
    const page = { kind: 'page' as const, id: s.site.homePageId };
    const item = (grid.props.items as Array<{ id: string }>)[1].id;
    // The refs as findings give them, with what they add to explain a finding.
    const cardRef = inspectionRef(s, { ctx: ctxOf(s, grid.id), node: 'card-text', items: item })!;
    expect(cardRef.match).toBe('nearest-part');
    const { host, asked } = hostFor(s, (targets) => ({
      viewportWidth: 390,
      issues: [{ kind: 'horizontal-overflow', message: 'The page is 420px wide in a 390px viewport.' }],
      runtimeErrors: [],
      targets: targets!.map((_, i) => (i === 0 ? { visible: true, elements: [measuredBox] } : { visible: false, elements: [{ box: null, scrollWidth: 0, scrollHeight: 0, visible: false }] }))
    }));
    const r = await executeTool('inspect_layout', JSON.stringify({ pageId: '/', viewport: 'phone', refs: [{ owner: page, nodeId: grid.id }, cardRef] }), host, 'c1');
    expect(r.ok).toBe(true);
    // The preview is asked for the elements the refs name, as the canvas finds them.
    expect(asked).toEqual([{ pageId: s.site.homePageId, width: 390, targets: [{ owner: page, instancePath: [], nodeId: grid.id }, { owner: page, instancePath: [grid.id], nodeId: 'card', partId: 'card', itemPath: [item] }] }]);
    const content = r.content as { scope?: string; pageId: string; report: { targets: Array<{ ref: unknown; visible: boolean }>; issues: unknown[] } };
    expect(content.scope).toBe('elements');
    expect(content.pageId).toBe(s.site.homePageId);
    // Each element by the ref it was asked by, without what explained the finding.
    expect(content.report.targets[0]).toEqual({ ref: { owner: page, nodeId: grid.id }, ...{ visible: true, elements: [measuredBox] } });
    expect(content.report.targets[1].ref).toEqual({ owner: page, nodeId: grid.id, partId: 'card', itemId: item });
    // Hidden at this width is a result, not an error, with what was measured.
    expect(content.report.targets[1]).toMatchObject({ visible: false, elements: [{ box: null, visible: false }] });
    // What belongs to the page as a whole comes along.
    expect(content.report.issues).toEqual([{ kind: 'horizontal-overflow', message: 'The page is 420px wide in a 390px viewport.' }]);
  });

  it('refuses a ref that names nothing on the page, naming it, without measuring anything', async () => {
    const s = fresh();
    const grid = placementOf(s, 'foundation.features.grid');
    const page = { kind: 'page' as const, id: s.site.homePageId };
    const other = s.site.pageOrder.find((id) => id !== s.site.homePageId)!;
    const cases: Array<[unknown, RegExp]> = [
      [{ owner: page, nodeId: 'n_gone' }, /refs\[1\].*n_gone.*not on this page/],
      [{ owner: { kind: 'page', id: other }, nodeId: grid.id }, /refs\[1\].*another page/],
      [{ owner: page, nodeId: grid.id, partId: 'nope' }, /refs\[1\].*part "nope"/],
      [{ owner: page, nodeId: grid.id, partId: 'cardTitle', itemId: 'gone' }, /refs\[1\].*item gone/],
      [{ owner: page, nodeId: grid.id, partId: 'heading', itemId: 'x' }, /refs\[1\].*not repeated/],
      // An empty item ID would match every item in the preview.
      [{ owner: page, nodeId: grid.id, partId: 'cardTitle', itemId: '' }, /refs\[1\].*empty itemId/],
      [{ owner: page, nodeId: 'toString' }, /refs\[1\].*not on this page/],
      [{ owner: { kind: 'component', id: grid.definitionId }, nodeId: 'card' }, /refs\[1\].*not on a page/]
    ];
    for (const [bad, message] of cases) {
      const { host, asked } = hostFor(s, () => ({ issues: [] }));
      const r = await executeTool('inspect_layout', JSON.stringify({ pageId: '/', viewport: 'phone', refs: [{ owner: page, nodeId: grid.id }, bad] }), host, 'c1');
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect(r.content).toMatchObject({ error: 'INVALID_ARGUMENT', viewport: 'phone' });
      expect((r.content as { message: string }).message).toMatch(message);
      expect(asked).toEqual([]);
    }
    // An empty list would check nothing: it is refused rather than read as a clean page.
    const empty = hostFor(s, () => ({ issues: [], targets: [] }));
    expect(await executeTool('inspect_layout', JSON.stringify({ pageId: '/', viewport: 'phone', refs: [] }), empty.host, 'c1')).toMatchObject({ ok: false, content: { error: 'INVALID_ARGUMENT' } });
    expect(empty.asked).toEqual([]);
  });

  it('takes the shared header the page shows, and refuses it on a page that hides it', () => {
    const s = fresh();
    const header = s.site.shell.header;
    const ref = { owner: { kind: 'shell' as const, id: 'header' }, nodeId: header.rootIds[0] };
    expect(resolveLayoutTargets(s, s.site.homePageId, [ref])).toEqual({ ok: true, targets: [{ owner: ref.owner, instancePath: [], nodeId: header.rootIds[0] }] });
    const footer = { owner: { kind: 'shell' as const, id: 'footer' }, nodeId: s.site.shell.footer.rootIds[0] };
    expect(resolveLayoutTargets(s, s.site.homePageId, [footer])).toMatchObject({ ok: true });
    const hidden = applyOperations(s, [{ type: 'page.update', pageId: s.site.homePageId, showHeader: false }]).state;
    expect(resolveLayoutTargets(hidden, s.site.homePageId, [ref])).toMatchObject({ ok: false, message: expect.stringMatching(/header this page does not show/) });
    expect(resolveLayoutTargets(hidden, s.site.homePageId, [footer])).toMatchObject({ ok: true });
  });

  it('measures the whole page as before without refs, and fails a narrowed check whose elements were not measured', async () => {
    const s = fresh();
    const grid = placementOf(s, 'foundation.features.grid');
    const whole = hostFor(s, () => ({ issues: [] }));
    const r = await executeTool('inspect_layout', JSON.stringify({ pageId: '/', viewport: 'desktop' }), whole.host, 'c1');
    expect(r.ok).toBe(true);
    expect(whole.asked).toEqual([{ pageId: s.site.homePageId, width: 1280 }]);
    expect((r.content as { scope?: string }).scope).toBeUndefined();
    // A preview that answered without the elements (an older frame) is a check that did not run.
    const blind = hostFor(s, () => ({ issues: [] }));
    const one = JSON.stringify({ pageId: '/', viewport: 'desktop', refs: [{ owner: { kind: 'page', id: s.site.homePageId }, nodeId: grid.id }] });
    expect(await executeTool('inspect_layout', one, blind.host, 'c1')).toMatchObject({ ok: false, content: { error: 'VALIDATION_FAILED' } });
    // Nor one that answered for each element without measuring it.
    for (const targets of [[null], [{ visible: true }], [{ visible: 'yes', elements: [] }], [{ visible: false, elements: [{ box: null, visible: false, measured: false }] }], [], [{ visible: true, elements: [] }, { visible: true, elements: [] }]]) {
      const odd = hostFor(s, () => ({ issues: [], targets }));
      expect(await executeTool('inspect_layout', one, odd.host, 'c1'), JSON.stringify(targets)).toMatchObject({ ok: false, content: { error: 'VALIDATION_FAILED' } });
    }
  });

  it('turns every ref a finding names back into the element the preview measured', () => {
    const s = fresh();
    const grid = placementOf(s, 'foundation.features.grid');
    const item = (grid.props.items as Array<{ id: string }>)[0].id;
    // Elements as the preview marks them: a part in one card, a part outside the list, the placement's root, a page node.
    const descs = [
      { ctx: ctxOf(s, grid.id), node: 'card-title', items: item },
      { ctx: ctxOf(s, grid.id), node: 'heading', items: '' },
      { ctx: ctxOf(s, grid.id), node: 'root', items: '' }
    ];
    for (const d of descs) {
      const ref = inspectionRef(s, d)!;
      const found = resolveLayoutTargets(s, s.site.homePageId, [ref]);
      if (!found.ok) throw new Error(found.message);
      const { ctx, node, items } = descOf(s, found.targets[0]);
      expect({ ctx, node, items }, JSON.stringify(d)).toEqual(d);
    }
  });

  it('finds a part a code component marks by its marker inside the placement, and the placement by its root part', () => {
    const page = { kind: 'page' as const, id: '' };
    const made = applyOperations(fresh(), [{ type: 'component.createCode', name: 'Note', source: '<p data-so-part="total">x</p>\n', properties: {} }]);
    const definitionId = made.results[0].definitionId as string;
    page.id = made.state.site.homePageId;
    const placed = applyOperations(made.state, [{ type: 'node.insert', owner: page, definitionId }]);
    const s = placed.state;
    const code = placed.results[0].nodeId as string;
    // Declared as saving the code declares it.
    s.components[definitionId].parts = { ...s.components[definitionId].parts, total: { nodeId: 'total', label: 'Total' } };
    const found = resolveLayoutTargets(s, page.id, [{ owner: page, nodeId: code, partId: 'total' }, { owner: page, nodeId: code, partId: 'root' }, { owner: page, nodeId: code }]);
    if (!found.ok) throw new Error(found.message);
    expect(found.targets.map((t) => descOf(s, t))).toEqual([
      { ctx: ctxOf(s), node: code, items: '', part: 'total' },
      { ctx: ctxOf(s), node: code, items: '' },
      { ctx: ctxOf(s), node: code, items: '' }
    ]);
  });
});

describe('the result card after a check of chosen elements', () => {
  it('keeps the page row as the whole-page check left it, and lets a later whole-page check replace it', () => {
    const state = fresh();
    const home = state.site.homePageId;
    const log = new InspectionLog();
    log.record(home, 'phone', true, { viewport: 'phone', report: { issues: [{ kind: 'element-overflow', message: 'Extends beyond the viewport.' }] } });
    const before = log.checks(state);
    expect(before[0].status).toBe('issue');
    // The hero was fixed and checked on its own: the page is not thereby checked.
    log.invalidate(new Set([home]));
    log.record(home, 'phone', true, { viewport: 'phone', scope: 'elements', report: { issues: [] } }, undefined, true);
    log.record(home, 'phone', false, { error: 'INVALID_ARGUMENT', viewport: 'phone' }, undefined, true);
    expect(log.checks(state)).toEqual(before.map((c) => ({ status: 'unverified', text: `${c.text.replace(/\.$/, '')}, before later changes.` })));
    // A page only ever checked element by element has no row, whether the checks passed or failed.
    const other = new InspectionLog();
    other.record(home, 'desktop', true, { viewport: 'desktop', scope: 'elements', report: { issues: [] } }, undefined, true);
    other.record(home, 'tablet', false, { error: 'INVALID_ARGUMENT', viewport: 'tablet' }, undefined, true);
    expect(other.checks(state)).toEqual([]);
    // Measured whole again, the page's latest result stands.
    log.record(home, 'phone', true, { viewport: 'phone', report: { issues: [] } });
    expect(log.checks(state).map((c) => c.status)).toEqual(['pass']);
  });

  it('tells a narrowed call by its arguments, whether or not it ran', () => {
    expect(narrowedInspection(JSON.stringify({ pageId: '/', viewport: 'phone', refs: [{ owner: { kind: 'page', id: 'p' }, nodeId: 'n' }] }))).toBe(true);
    expect(narrowedInspection(JSON.stringify({ pageId: '/', viewport: 'phone', refs: [] }))).toBe(true);
    expect(narrowedInspection(JSON.stringify({ pageId: '/', viewport: 'phone', refs: null }))).toBe(true);
    expect(narrowedInspection(JSON.stringify({ pageId: '/', viewport: 'phone' }))).toBe(false);
    expect(narrowedInspection('{not json')).toBe(false);
  });
});
