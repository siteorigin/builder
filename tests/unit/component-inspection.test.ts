/**
 * inspect_component (#362): the cases a component is measured in (variant options one at a time, long text, links and
 * optional text left empty, one and five list items), and the digest of what the measurements found.
 */
import { describe, expect, it } from 'vitest';
import type { ComponentPreviewResult } from '@shared/component-preview';
import type { ComponentDefinition, InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { catalogueEntries } from '@catalogue/index';
import { installComponent, makeInstance } from '@engine/install';
import { generateComponentPreview } from '@generator/preview';
import { componentLocation, digestComponentInspection, INSPECT_WIDTHS, inspectionSteps, MAX_CASES, planComponentInspection, resolveInspectTarget, type InspectCase, type InspectTarget } from '@agent/component-inspection';

const LINK = { type: 'url', target: 'https://a.test/' };
const NONE = { type: 'none', target: '' };

/** A project component with two variant axes, text, links (one empty), an optional eyebrow and two lists. */
const card = (): ComponentDefinition =>
  ({
    schemaVersion: 1,
    id: 'proj_card',
    componentId: 'proj_card',
    contractVersion: 1,
    kind: 'managed',
    owner: 'project',
    name: 'Offer card',
    description: '',
    category: 'content',
    tags: [],
    properties: {
      heading: { type: 'string', label: 'Heading', default: 'Spring offer', maxLength: 40 },
      body: { type: 'richtext', label: 'Body', default: [{ type: 'p', spans: [{ text: 'Ten percent off.' }] }] },
      eyebrow: { type: 'string', label: 'Eyebrow', default: 'New' },
      more: { type: 'link', label: 'More link', default: NONE },
      cta: { type: 'object', label: 'Button', fields: { label: { type: 'string', label: 'Label', default: 'Book' }, link: { type: 'link', label: 'Link', default: LINK } }, default: { label: 'Book', link: LINK } },
      items: { type: 'list', label: 'Points', itemLabel: 'Point', min: 1, max: 4, fields: { title: { type: 'string', label: 'Title', default: 'Point' } }, default: [{ id: 'p1', title: 'Fast' }, { id: 'p2', title: 'Kind' }] },
      latest: { type: 'list', label: 'Latest', itemLabel: 'Article', feed: 'articles', fields: { title: { type: 'string', label: 'Title', default: '' } }, default: [] }
    },
    parts: { root: { nodeId: 'r', label: 'Card' }, title: { nodeId: 'h', label: 'Title' }, actions: { nodeId: 'row', label: 'Actions' } },
    variantAxes: {
      tone: { label: 'Tone', default: 'light', options: { light: { label: 'Light' }, inverse: { label: 'Inverse' }, accent: { label: 'Accent' } } },
      layout: { label: 'Layout', default: 'stacked', options: { stacked: { label: 'Stacked' }, split: { label: 'Split' } } }
    },
    tree: {
      rootIds: ['r'],
      nodes: {
        r: { id: 'r', kind: 'element', tag: 'div', children: ['e', 'h', 'row', 'list'] },
        e: { id: 'e', kind: 'text', tag: 'p', text: { $prop: 'eyebrow' }, when: { $prop: 'eyebrow' } },
        h: { id: 'h', kind: 'text', tag: 'h3', text: { $prop: 'heading' } },
        row: { id: 'row', kind: 'element', tag: 'div', children: ['btn'] },
        btn: { id: 'btn', kind: 'text', tag: 'span', text: 'Book' },
        list: { id: 'list', kind: 'element', tag: 'ul', children: [] }
      }
    }
  }) as unknown as ComponentDefinition;

const target = (def = card(), extra: Partial<InspectTarget> = {}): InspectTarget => ({ def, select: { definitionId: def.id }, values: { heading: 'Spring offer', body: def.properties.body.default, eyebrow: 'New', more: NONE, cta: { label: 'Book', link: LINK }, items: [{ id: 'p1', title: 'Fast' }, { id: 'p2', title: 'Kind' }] }, variants: {}, notes: [], ...extra });
const labels = (cases: InspectCase[]) => cases.map((c) => c.label);
const byLabel = (cases: InspectCase[], label: string) => cases.find((c) => c.label === label)!;

describe('planning the cases (#362)', () => {
  it('measures the starting point, the stress cases, then each other variant option on its own', () => {
    const cases = planComponentInspection(target());
    expect(labels(cases)).toEqual(['defaults', 'links set', 'empty', 'long text', '1 item', '5 items', 'tone=inverse', 'tone=accent', 'layout=split']);
    // One axis changed at a time, never their product.
    expect(byLabel(cases, 'tone=inverse').variants).toEqual({ tone: 'inverse' });
    expect(byLabel(cases, 'layout=split').variants).toEqual({ layout: 'split' });
    for (const c of cases.filter((x) => !x.label.includes('='))) expect(c.variants).toEqual({});
    expect(planComponentInspection(target())).toEqual(cases);
  });

  it('shows every link to compare with, then leaves the links and the optional text empty', () => {
    const cases = planComponentInspection(target());
    const shown = byLabel(cases, 'links set').props;
    expect(shown.more).toEqual({ type: 'url', target: 'https://example.com/' });
    expect((shown.cta as { link: unknown }).link).toEqual(LINK);
    const empty = byLabel(cases, 'empty');
    expect(empty.control).toBe('links set');
    expect(empty.props.more).toEqual(NONE);
    expect((empty.props.cta as { link: unknown; label: string }).link).toEqual(NONE);
    // Shown only when it has a value, so it is left empty too; text that is always shown keeps its value.
    expect(empty.props.eyebrow).toBe('');
    expect(empty.props.heading).toBe('Spring offer');
    expect((empty.props.cta as { label: string }).label).toBe('Book');
  });

  it('puts a long unbroken word into every text field, within its length limit', () => {
    const long = byLabel(planComponentInspection(target()), 'long text').props;
    expect(String(long.heading)).toHaveLength(40);
    expect(String(long.heading)).toMatch(/^[A-Za-z]{40}$/);
    expect(String(long.eyebrow).length).toBeGreaterThan(150);
    expect(JSON.stringify(long.body)).toMatch(/[A-Za-z]{60}/);
    expect((long.cta as { label: string }).label.length).toBeGreaterThan(150);
    expect((long.items as Array<{ title: string }>).every((i) => i.title.length > 150)).toBe(true);
    // Links are left as they are.
    expect((long.cta as { link: unknown }).link).toEqual(LINK);
  });

  it('tries one and five items within each list’s limits, never a list that fills itself', () => {
    const cases = planComponentInspection(target());
    expect((byLabel(cases, '1 item').props.items as unknown[]).length).toBe(1);
    // At most four.
    const five = byLabel(cases, '5 items').props.items as Array<{ id: string; title: string }>;
    expect(five.map((i) => i.title)).toEqual(['Fast', 'Kind', 'Fast', 'Kind']);
    expect(five.map((i) => i.id)).toEqual(['sweep1', 'sweep2', 'sweep3', 'sweep4']);
    for (const c of cases) expect(c.props.latest).toBeUndefined();
  });

  it('measures the same thing once, under both names', () => {
    const def = card();
    // No link left empty and no optional text: showing the links changes nothing, so the start is the control.
    const t = target(def, { values: { ...target().values, more: LINK, eyebrow: '', items: [{ id: 'p1', title: 'Fast' }] } });
    const cases = planComponentInspection(t);
    expect(labels(cases).slice(0, 2)).toEqual(['defaults + links set', 'empty']);
    expect(byLabel(cases, 'empty').control).toBe('defaults + links set');
    // A list already at one item adds no case of its own.
    expect(labels(cases)).not.toContain('1 item');
    // Links already empty with nothing optional: the start is the empty case, compared with the links shown.
    const bare = planComponentInspection(target(def, { values: { ...target().values, eyebrow: '', cta: { label: 'Book', link: NONE } } }));
    expect(labels(bare).slice(0, 2)).toEqual(['defaults + empty', 'links set']);
    expect(byLabel(bare, 'defaults + empty').control).toBe('links set');
  });

  it('starts from a placement’s own content and variant choices, and says what its bindings left out', () => {
    const s = createStarterState('blank', 'Inspect', false);
    const def = s.components[installComponent(s, 'cta.banner')];
    const axis = Object.keys(def.variantAxes ?? {})[0];
    const options = axis ? Object.keys(def.variantAxes![axis].options) : [];
    const chosen = options.find((o) => o !== def.variantAxes![axis].default);
    const node: InstanceNode = { ...makeInstance(def, { heading: 'Book a visit' }, axis && chosen ? { [axis]: chosen } : undefined), id: 'n_cta' };
    const home = s.pages[s.site.homePageId];
    home.nodes[node.id] = node;
    home.rootIds.push(node.id);
    const t = resolveInspectTarget(s, { owner: { kind: 'page', id: home.id }, nodeId: 'n_cta' });
    if ('error' in t) throw new Error(t.error);
    expect(t.placement).toEqual({ owner: { kind: 'page', id: home.id }, nodeId: 'n_cta' });
    expect(t.values.heading).toBe('Book a visit');
    const cases = planComponentInspection(t);
    expect(cases[0].label).toBe('as placed');
    if (axis && chosen) {
      expect(cases[0].variants).toEqual({ [axis]: chosen });
      // The axis default is one of the other options measured.
      expect(cases.some((c) => c.variants[axis] === def.variantAxes![axis].default)).toBe(true);
    }
  });

  it('names exactly one component, and says what is wrong with anything else', () => {
    const s = createStarterState('blank', 'Inspect', false);
    expect(resolveInspectTarget(s, {})).toEqual({ error: expect.stringContaining('Name one component') });
    expect(resolveInspectTarget(s, { definitionId: 'a', componentId: 'b' })).toEqual({ error: expect.stringContaining('Name one component') });
    expect(resolveInspectTarget(s, { definitionId: 'nope' })).toEqual({ error: expect.stringContaining('no component "nope"') });
    expect(resolveInspectTarget(s, { componentId: 'nope.nope' })).toEqual({ error: expect.stringContaining('no component "nope.nope"') });
    expect(resolveInspectTarget(s, { owner: { kind: 'page', id: s.site.homePageId } })).toEqual({ error: expect.stringContaining('both owner and nodeId') });
    expect(resolveInspectTarget(s, { owner: { kind: 'page', id: 'pg_none' }, nodeId: 'n' })).toEqual({ error: expect.stringContaining('no page') });
    // A theme component the project does not have yet is shown as adding it would make it.
    const t = resolveInspectTarget(s, { componentId: 'features.grid' });
    if ('error' in t) throw new Error(t.error);
    expect(t.select).toEqual({ componentId: 'features.grid' });
  });

  it('asks for each case at phone and then desktop width in one frame', () => {
    const t = target();
    const cases = planComponentInspection(t).slice(0, 2);
    const steps = inspectionSteps(t, cases);
    expect(steps.map((s) => s.width)).toEqual([INSPECT_WIDTHS.phone, INSPECT_WIDTHS.desktop, INSPECT_WIDTHS.phone, INSPECT_WIDTHS.desktop]);
    expect(steps.every((s) => s.frame === 0 && s.spec.definitionId === 'proj_card')).toBe(true);
    expect(steps[0].spec).toBe(steps[1].spec);
  });

  // Integration: every case planned for every component of every bundled theme is a preview the generator makes.
  it('plans only sample values the preview accepts, for every theme component', () => {
    const s = createStarterState('blank', 'Inspect', false);
    let checked = 0;
    for (const entry of catalogueEntries(s.site.themeId)) {
      const t = resolveInspectTarget(s, { componentId: entry.componentId });
      if ('error' in t) throw new Error(t.error);
      for (const c of planComponentInspection(t)) {
        const made = generateComponentPreview(s, { ...t.select, variants: c.variants, props: c.props });
        expect('error' in made ? `${entry.componentId} ${c.label}: ${made.error}` : '').toBe('');
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(catalogueEntries(s.site.themeId).length);
  });
});

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

const ctx = 'preview:proj_card|preview';
const ready = (issues: unknown[], extra: Record<string, unknown> = {}, width = 390): ComponentPreviewResult => ({
  state: 'ready',
  width,
  definitionId: 'proj_card',
  bounds: { x: 0, y: 0, width, height: 200 },
  text: '',
  report: { viewportWidth: width, issues, runtimeErrors: [], checks: { contrast: { checked: 4, failed: 0, unverified: 0 }, overlaps: { checked: 6, failed: 0, unverified: 0 }, clippedText: { checked: 2, failed: 0, unverified: 0 }, tapTargets: { checked: 1, failed: 0, unverified: 0 } }, ...extra }
});
/** Results for `cases` at both widths, each made by `at(label, width)`. */
const resultsFor = (cases: InspectCase[], at: (label: string, width: number) => ComponentPreviewResult) => cases.flatMap((c) => [at(c.label, 390), at(c.label, 1280)]);
const plan = () => planComponentInspection(target()).slice(0, MAX_CASES);

describe('the digest (#362)', () => {
  it('keeps a clean component to one short summary line', () => {
    const cases = plan();
    const d = digestComponentInspection(target(), cases, resultsFor(cases, (_l, w) => ready([], {}, w)), { offset: 0, total: 9 });
    expect(d.measured).toBe(16);
    expect(d.content.summary).toBe('Offer card: no problems found in 8 cases at phone (390px) and desktop (1280px) width. 1 more case to measure: call again with offset 8.');
    expect(Object.keys(d.content).sort()).toEqual(['cases', 'definitionId', 'next', 'summary']);
    expect(d.content.next).toEqual({ offset: 8, remaining: 1 });
  });

  it('reports each defect once, with the cases and widths it showed in and where it is in the design', () => {
    const cases = plan();
    const overflow = { kind: 'text-overflow', desc: { ctx, node: 'h', items: '' }, text: 'Pneumono…', message: 'Text is wider than its box.' };
    const contrast = { kind: 'low-contrast', desc: { ctx, node: 'btn', items: '' }, text: 'Book', ratio: 1.9, message: 'Text contrast is 1.9:1 (#777 on #111); text this size needs at least 4.5:1.' };
    const d = digestComponentInspection(
      target(),
      cases,
      resultsFor(cases, (label, w) => ready([...(label === 'long text' && w === 390 ? [overflow] : []), ...(label === 'tone=inverse' ? [contrast] : []), { kind: 'image-unverified', message: 'still loading' }], {}, w)),
      { offset: 0, total: 8 }
    );
    expect(d.content.findings).toEqual([
      { kind: 'text-overflow', message: 'Text is wider than its box.', text: 'Pneumono…', at: { nodeId: 'h', partId: 'title' }, in: ['long text: phone'] },
      { kind: 'low-contrast', message: contrast.message, text: 'Book', at: { nodeId: 'btn', partId: 'actions', match: 'nearest-part' }, in: ['tone=inverse: phone, desktop'] }
    ]);
    expect(d.content.summary).toMatch(/^Offer card: 2 problems found in 8 cases/);
  });

  it('reports a measurement that failed as one, never as clean, and leaves the cases not reached for the next call', () => {
    const cases = plan();
    const results = resultsFor(cases, (label, w) => (label === 'tone=inverse' ? { state: 'error', error: 'Timed out measuring the component preview.', width: w } : ready([], {}, w)));
    const all = digestComponentInspection(target(), cases, results, { offset: 0, total: 9 });
    expect(all.measured).toBe(14);
    expect(all.content.failed).toEqual([{ error: 'Timed out measuring the component preview.', in: ['tone=inverse: phone, desktop'] }]);
    expect(all.content.summary).toContain('2 measurements failed');
    expect(all.content.summary).not.toContain('no problems');
    // Six and a half cases came back before the time ran out: the half-measured one is measured again next time.
    const cut = digestComponentInspection(target(), cases, results.slice(0, 13), { offset: 0, total: 9 });
    expect(cut.measured).toBe(12);
    expect(cut.content.summary).toContain('1 measurement failed');
    expect(cut.content.next).toEqual({ offset: 6, remaining: 3 });
    const none = digestComponentInspection(target(), cases, [], { offset: 0, total: 9 });
    expect(none.measured).toBe(0);
  });

  it('lists runtime errors once with where they happened', () => {
    const cases = plan().slice(0, 1);
    const d = digestComponentInspection(target(), cases, resultsFor(cases, (_l, w) => ready([], { runtimeErrors: ['TypeError: x is undefined'] }, w)), { offset: 0, total: 1 });
    expect(d.content.runtimeErrors).toEqual([{ error: 'TypeError: x is undefined', in: ['defaults: phone, desktop'] }]);
  });

  it('names elements of the design, of a component placed in it, and leaves a code component’s own markup to the whole', () => {
    const def = card();
    expect(componentLocation(def, { ctx, node: 'h' })).toEqual({ nodeId: 'h', partId: 'title' });
    expect(componentLocation(def, { ctx, node: 'btn' })).toEqual({ nodeId: 'btn', partId: 'actions', match: 'nearest-part' });
    expect(componentLocation(def, { ctx: `${ctx}|row`, node: 'inner' })).toEqual({ nodeId: 'row', partId: 'actions', match: 'nearest-part' });
    expect(componentLocation(def, { ctx: 'preview:proj_card', node: 'preview', inside: true })).toBeUndefined();
    expect(componentLocation(def, { ctx: 'page:pg_a', node: 'h' })).toBeUndefined();
    expect(componentLocation(def, { ctx, node: 'gone' })).toBeUndefined();
  });

  describe('spacing that went with content left empty', () => {
    const at = (node: string, n = 0, of = 1) => ({ ctx, node, n, of });
    const gap = (a: ReturnType<typeof at>, b: ReturnType<typeof at>, g: number) => ({ a, b, gap: g });
    const digest = (control: unknown[], empty: unknown[]) => {
      const cases: InspectCase[] = [
        { label: 'links set', variants: {}, props: {} },
        { label: 'empty', variants: {}, props: {}, control: 'links set' }
      ];
      return digestComponentInspection(target(), cases, resultsFor(cases, (label, w) => ready([], { gaps: label === 'empty' ? empty : control }, w)), { offset: 0, total: 2 }).content;
    };

    it('finds two elements that touch once what carried the space between them is gone', () => {
      // Heading, button row (24px above and below it), list; with the links empty the row is gone.
      const found = digest([gap(at('h'), at('row'), 24), gap(at('row'), at('list'), 24)], [gap(at('h'), at('list'), 0)]);
      expect(found.findings).toEqual([expect.objectContaining({ kind: 'spacing-collapse', at: { nodeId: 'h', partId: 'title' }, with: { at: { nodeId: 'list', partId: 'root', match: 'nearest-part' } }, in: ['empty: phone, desktop'] })]);
      expect((found.findings as Array<{ message: string }>)[0].message).toContain('at least 24px');
    });

    it('finds a gap between the same two elements that closed', () => {
      expect(digest([gap(at('h'), at('list'), 16)], [gap(at('h'), at('list'), 0)]).findings).toHaveLength(1);
    });

    it('leaves alone spacing that stays, elements that touched already, and something still between them', () => {
      // The container's gap keeps them apart.
      expect(digest([gap(at('h'), at('row'), 16), gap(at('row'), at('list'), 16)], [gap(at('h'), at('list'), 16)]).findings).toBeUndefined();
      // They touched the row before.
      expect(digest([gap(at('h'), at('row'), 0), gap(at('row'), at('list'), 24)], [gap(at('h'), at('list'), 0)]).findings).toBeUndefined();
      // The row is still there, so the heading and the list were never neighbours.
      expect(digest([gap(at('h'), at('row'), 24), gap(at('row'), at('list'), 24)], [gap(at('h'), at('list'), 0), gap(at('row'), at('e'), 0)]).findings).toBeUndefined();
    });

    it('skips an element repeated a different number of times, whose position no longer says which it is', () => {
      // Three rows of one design node; the first held only a link and is gone, so the other two are now 0 and 1.
      const control = [gap(at('row', 0, 3), at('row', 1, 3), 16), gap(at('row', 1, 3), at('row', 2, 3), 0)];
      const empty = [gap(at('row', 0, 2), at('row', 1, 2), 0)];
      expect(digest(control, empty).findings).toBeUndefined();
    });
  });
});
