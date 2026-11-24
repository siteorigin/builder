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
import { componentLocation, digestComponentInspection, INSPECT_WIDTHS, inspectionSteps, MAX_CASES, planComponentInspection, resolveInspectTarget, resumeAt, type InspectCase, type InspectTarget } from '@agent/component-inspection';

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
    const t = target();
    const before = JSON.stringify(t);
    const cases = planComponentInspection(t);
    expect(cases.map((c) => [c.label, c.variants])).toEqual([
      ['defaults', {}],
      ['filled', {}],
      ['empty', {}],
      ['long text', {}],
      ['1 item', {}],
      ['4 items', {}],
      // One axis changed at a time, never their product.
      ['tone=inverse', { tone: 'inverse' }],
      ['tone=accent', { tone: 'accent' }],
      ['layout=split', { layout: 'split' }]
    ]);
    // The variants show the content filled, so what shows only with content is measured in every option.
    expect(byLabel(cases, 'tone=inverse').props).toEqual(byLabel(cases, 'filled').props);
    expect(byLabel(cases, 'defaults').props).toEqual(t.values);
    expect(planComponentInspection(t)).toEqual(cases);
    expect(JSON.stringify(t)).toBe(before);
  });

  it('sets every link and fills empty text to compare with, then leaves the links and the optional text empty', () => {
    const cases = planComponentInspection(target());
    const shown = byLabel(cases, 'filled').props;
    expect(shown.more).toEqual({ type: 'url', target: 'https://example.com/' });
    expect((shown.cta as { link: unknown }).link).toEqual(LINK);
    const empty = byLabel(cases, 'empty');
    expect(empty.control).toBe('filled');
    expect(empty.props.more).toEqual(NONE);
    expect((empty.props.cta as { link: unknown; label: string }).link).toEqual(NONE);
    // Shown only when it has a value, so it is left empty too; text that is always shown keeps its value.
    expect(empty.props.eyebrow).toBe('');
    expect(empty.props.heading).toBe('Spring offer');
    expect((empty.props.cta as { label: string }).label).toBe('Book');
  });

  it('empties an optional item field only in the list that shows it only when present, and reads present-tests of every kind', () => {
    const def = card();
    def.properties.team = { type: 'list', label: 'Team', itemLabel: 'Person', fields: { title: { type: 'string', label: 'Title', default: '' } }, default: [] } as never;
    def.properties.caption = { type: 'string', label: 'Caption', default: '' } as never;
    def.properties.note = { type: 'string', label: 'Note', default: '' } as never;
    Object.assign(def.tree!.nodes, {
      rep: { id: 'rep', kind: 'repeat', list: { $prop: 'team' }, children: ['t'] },
      t: { id: 't', kind: 'text', tag: 'p', text: { $item: 'title' }, when: { $item: 'title' } },
      cap: { id: 'cap', kind: 'text', tag: 'p', text: { $prop: 'caption' }, when: { ref: { $prop: 'caption' }, ne: '' } },
      nt: { id: 'nt', kind: 'text', tag: 'p', text: { $prop: 'note' }, unless: { ref: { $prop: 'note' }, eq: '' } }
    });
    (def.tree!.nodes.r as { children: string[] }).children.push('rep', 'cap', 'nt');
    const values = { ...target().values, team: [{ id: 'm1', title: 'Chef' }], caption: 'Fresh', note: 'Open daily' };
    const empty = byLabel(planComponentInspection(target(def, { values })), 'empty').props;
    expect(empty.team).toEqual([{ id: 'm1', title: '' }]);
    // The points list's titles are always shown: they keep their text.
    expect((empty.items as Array<{ title: string }>).map((i) => i.title)).toEqual(['Fast', 'Kind']);
    expect(empty.caption).toBe('');
    expect(empty.note).toBe('');
  });

  it('puts a long unbroken word into every text a visitor reads, within its length limit, and leaves addresses alone', () => {
    const def = card();
    def.properties.video = { type: 'string', label: 'Video address', default: '' } as never;
    def.properties.page = { type: 'string', label: 'Page', default: '/about/' } as never;
    const long = byLabel(planComponentInspection(target(def, { values: { ...target().values, video: 'https://vimeo.com/1', page: '/about/' } })), 'long text').props;
    expect(String(long.heading)).toMatch(/^[A-Za-z]{40}$/);
    expect(String(long.eyebrow).length).toBeGreaterThan(150);
    expect(long.body).toEqual([{ type: 'p', spans: [{ text: expect.stringMatching(/^[A-Za-z]{60}/) }] }]);
    expect((long.cta as { label: string }).label.length).toBeGreaterThan(150);
    expect((long.items as Array<{ title: string }>)).toHaveLength(2);
    expect((long.items as Array<{ title: string }>).every((i) => i.title.length > 150)).toBe(true);
    // Links are set, so the buttons that need one show their long labels.
    expect(long.more).toEqual({ type: 'url', target: 'https://example.com/' });
    expect(long.video).toBe('https://vimeo.com/1');
    expect(long.page).toBe('/about/');
  });

  it('tries one and five items within each list’s limits, with content enough to show, never in a list that fills itself', () => {
    const def = card();
    def.properties.steps = { type: 'list', label: 'Steps', itemLabel: 'Step', min: 3, fields: { label: { type: 'string', label: 'Label', default: '' }, link: { type: 'link', label: 'Link', default: NONE } }, default: [] } as never;
    const cases = planComponentInspection(target(def, { values: { ...target().values, steps: [] } }));
    // Lists that come out at different lengths are named by the count asked for.
    const one = byLabel(cases, '1 item').props;
    expect((one.items as unknown[]).length).toBe(1);
    expect(one.steps).toEqual([1, 2, 3].map((i) => ({ id: `sweep${i}`, label: 'Sample text', link: { type: 'url', target: 'https://example.com/' } })));
    const five = byLabel(cases, '5 items').props;
    expect((five.items as Array<{ id: string; title: string }>).map((i) => [i.id, i.title])).toEqual([['sweep1', 'Fast'], ['sweep2', 'Kind'], ['sweep3', 'Fast'], ['sweep4', 'Kind']]);
    expect((five.steps as unknown[]).length).toBe(5);
    for (const c of cases) expect(c.props.latest).toBeUndefined();
  });

  it('measures the same thing once, under both names', () => {
    const def = card();
    // Nothing to fill: the filled case is the start, and the empty case is compared with it.
    const t = target(def, { values: { ...target().values, more: LINK, items: [{ id: 'p1', title: 'Fast' }] } });
    const cases = planComponentInspection(t);
    expect(labels(cases).slice(0, 2)).toEqual(['defaults + filled', 'empty']);
    expect(byLabel(cases, 'empty').control).toBe('defaults + filled');
    // A list already at one item adds no case of its own.
    expect(labels(cases)).not.toContain('1 item');
    // Links already empty and nothing optional: the start is the empty case, compared with the links set.
    const bare = planComponentInspection(target(def, { values: { ...target().values, eyebrow: '', cta: { label: 'Book', link: NONE } } }));
    expect(labels(bare).slice(0, 2)).toEqual(['defaults + empty', 'filled']);
    expect(byLabel(bare, 'defaults + empty').control).toBe('filled');
  });

  it('starts from a placement’s own content and variant choices, and says what its bindings and slots left out', () => {
    const s = createStarterState('blank', 'Inspect', false);
    const def = s.components[installComponent(s, 'cta.banner')];
    const [axis, a] = Object.entries(def.variantAxes ?? {})[0];
    const chosen = Object.keys(a.options).find((o) => o !== a.default)!;
    const node: InstanceNode = { ...makeInstance(def, { heading: 'Book a visit' }, { [axis]: chosen }), id: 'n_cta' };
    const lead = Object.keys(def.properties).find((k) => k !== 'heading' && def.properties[k].type === 'string')!;
    node.props[lead] = { $prop: 'intro' };
    node.overrides = { root: { base: { paddingBlock: '2rem' } } };
    const home = s.pages[s.site.homePageId];
    home.nodes[node.id] = node;
    home.rootIds.push(node.id);
    const t = resolveInspectTarget(s, { owner: { kind: 'page', id: home.id }, nodeId: 'n_cta' });
    if ('error' in t) throw new Error(t.error);
    expect(t.placement).toEqual({ owner: { kind: 'page', id: home.id }, nodeId: 'n_cta' });
    expect(t.values.heading).toBe('Book a visit');
    expect(t.values[lead]).toEqual(def.properties[lead].default);
    expect(t.notes).toEqual([`Bound to its surroundings, so shown with the default: ${def.properties[lead].label}.`, 'Shown without its own style changes; inspect_layout measures it on its page.']);
    const cases = planComponentInspection(t);
    expect(cases[0].label).toBe('as placed');
    expect(cases[0].variants).toEqual({ [axis]: chosen });
    // The axis default is one of the other options measured.
    expect(cases.some((c) => c.variants[axis] === a.default)).toBe(true);
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
    // Once it has it, its own copy (with its own changes) is measured.
    const id = installComponent(s, 'features.grid');
    s.components[id].name = 'Our grid';
    const installed = resolveInspectTarget(s, { componentId: 'features.grid' });
    if ('error' in installed) throw new Error(installed.error);
    expect(installed.select).toEqual({ definitionId: id });
    expect(installed.def.name).toBe('Our grid');
  });

  it('asks for each case at phone and then desktop width in one frame, with that case’s variants and content', () => {
    const t = target();
    const cases = planComponentInspection(t);
    const steps = inspectionSteps(t, cases);
    expect(steps).toHaveLength(cases.length * 2);
    cases.forEach((c, i) => {
      for (const [j, width] of [INSPECT_WIDTHS.phone, INSPECT_WIDTHS.desktop].entries())
        expect(steps[i * 2 + j]).toEqual({ spec: { definitionId: 'proj_card', ...(Object.keys(c.variants).length ? { variants: c.variants } : {}), props: c.props }, width, frame: 0 });
    });
  });

  it('resumes a cut-short sweep with the case an empty case is compared with', () => {
    const cases = planComponentInspection(target());
    expect(resumeAt(cases, 2)).toBe(1);
    expect(resumeAt(cases, 1)).toBe(1);
    expect(resumeAt(cases, 3)).toBe(3);
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
const CHECKS = { contrast: { checked: 4, failed: 0, unverified: 0 }, overlaps: { checked: 6, failed: 0, unverified: 0 }, clippedText: { checked: 2, failed: 0, unverified: 0 }, tapTargets: { checked: 1, failed: 0, unverified: 0 } };
const ready = (issues: unknown[], extra: Record<string, unknown> = {}, width = 390): ComponentPreviewResult => ({
  state: 'ready',
  width,
  definitionId: 'proj_card',
  bounds: { x: 0, y: 0, width, height: 200 },
  text: '',
  report: { viewportWidth: width, issues, runtimeErrors: [], checks: CHECKS, gaps: [], ...extra }
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
    expect(Object.keys(d.content).sort()).toEqual(['cases', 'definitionId', 'name', 'next', 'summary']);
    expect(d.content.next).toEqual({ offset: 8, remaining: 1 });
  });

  it('reports each defect once, with the cases and widths it showed in and where it is in the design', () => {
    const cases = plan();
    const overflow = { kind: 'text-overflow', desc: { ctx, node: 'h', items: '' }, text: 'Pneumono…', message: 'Text is wider than its box.' };
    const contrast = { kind: 'low-contrast', desc: { ctx, node: 'btn', items: '' }, text: 'Book', ratio: 1.9, message: 'Text contrast is 1.9:1 (#777 on #111); text this size needs at least 4.5:1.' };
    const eyebrow = { ...contrast, desc: { ctx, node: 'e', items: '' }, text: 'New' };
    // The same overlap, its two boxes named the other way round at desktop width.
    const overlap = (w: number) => (w === 390 ? { kind: 'overlap', desc: { ctx, node: 'h' }, with: { desc: { ctx, node: 'row' }, text: 'Book' }, text: 'Spring', message: 'Overlaps.' } : { kind: 'overlap', desc: { ctx, node: 'row' }, with: { desc: { ctx, node: 'h' }, text: 'Spring' }, text: 'Book', message: 'Overlaps.' });
    const d = digestComponentInspection(
      target(),
      cases,
      resultsFor(cases, (label, w) =>
        ready([...(label === 'long text' && w === 390 ? [overflow] : []), ...(label.startsWith('tone=') ? [contrast] : []), ...(label === 'tone=inverse' && w === 1280 ? [eyebrow] : []), ...(label === '1 item' ? [overlap(w)] : []), { kind: 'image-unverified', message: 'still loading' }], {}, w)
      ),
      { offset: 0, total: 8 }
    );
    expect(d.content.findings).toEqual([
      { kind: 'text-overflow', message: 'Text is wider than its box.', text: 'Pneumono…', at: { nodeId: 'h', partId: 'title' }, in: ['long text: phone'] },
      { kind: 'overlap', message: 'Overlaps.', text: 'Spring', at: { nodeId: 'h', partId: 'title' }, with: { at: { nodeId: 'row', partId: 'actions' }, text: 'Book' }, in: ['1 item: phone, desktop'] },
      { kind: 'low-contrast', message: contrast.message, text: 'Book', at: { nodeId: 'btn', partId: 'actions', match: 'nearest-part' }, in: ['tone=inverse: phone, desktop', 'tone=accent: phone, desktop'] },
      { kind: 'low-contrast', message: contrast.message, text: 'New', at: { nodeId: 'e', partId: 'root', match: 'nearest-part' }, in: ['tone=inverse: desktop'] }
    ]);
    expect(d.content.summary).toMatch(/^Offer card: 4 problems found in 8 cases/);
  });

  it('reports a measurement that failed as one, never as clean, and leaves the cases not reached for the next call', () => {
    const cases = plan();
    const results = resultsFor(cases, (label, w) => (label === 'tone=inverse' ? { state: 'error', error: 'Timed out measuring the component preview.', width: w } : ready([], {}, w)));
    const all = digestComponentInspection(target(), cases, results, { offset: 0, total: 9 });
    expect(all.measured).toBe(14);
    expect(all.content.failed).toEqual([{ error: 'Timed out measuring the component preview.', in: ['tone=inverse: phone, desktop'] }]);
    expect(all.content.summary).toContain('2 measurements failed');
    expect(all.content.summary).not.toContain('no problems');
    expect(all.content.incomplete).toBe(true);
    // Six and a half cases came back before the time ran out: the half-measured one is measured again next time.
    const cut = digestComponentInspection(target(), cases, results.slice(0, 13), { offset: 0, total: 9 });
    expect(cut.measured).toBe(12);
    expect(cut.content.summary).toContain('1 measurement failed');
    expect(cut.content.next).toEqual({ offset: 6, remaining: 3 });
    // A measurement without its readability counts did not run every check.
    const partial = digestComponentInspection(target(), cases.slice(0, 1), resultsFor(cases.slice(0, 1), (_l, w) => ready([], { checks: undefined }, w)), { offset: 0, total: 1 });
    expect(partial.measured).toBe(0);
    expect(partial.content.failed).toEqual([{ error: 'The measurement did not run every check.', in: ['defaults: phone, desktop'] }]);
    const none = digestComponentInspection(target(), cases, [], { offset: 0, total: 9 });
    expect(none.measured).toBe(0);
  });

  it('goes on from a later window, never claiming a width it did not measure', () => {
    const all = planComponentInspection(target());
    const window = all.slice(6, 9);
    // tone=inverse at both widths, tone=accent at phone width only.
    const results = resultsFor(window, (_l, w) => ready([], {}, w)).slice(0, 3);
    const d = digestComponentInspection(target(), window, results, { offset: 6, total: 9, all });
    expect(d.content.cases).toEqual(['tone=inverse']);
    expect(d.content.offset).toBe(6);
    expect(d.content.next).toEqual({ offset: 7, remaining: 2 });
    expect(d.content.summary).toBe('Offer card: no problems found in 1 case at phone (390px) and desktop (1280px) width. "tone=accent" was measured at phone width only. 2 more cases to measure: call again with offset 7.');
    expect(d.content.incomplete).toBe(true);
    // Cut short between the filled case and the empty case compared with it: both are measured again.
    const first = all.slice(0, 8);
    const early = digestComponentInspection(target(), first, resultsFor(first, (_l, w) => ready([], {}, w)).slice(0, 5), { offset: 0, total: 9, all });
    expect(early.content.next).toEqual({ offset: 1, remaining: 8 });
  });

  it('lists runtime errors once each, told apart by their whole text', () => {
    const cases = plan().slice(0, 1);
    const long = (end: string) => `TypeError: ${'x'.repeat(100)} ${end}`;
    const d = digestComponentInspection(target(), cases, resultsFor(cases, (_l, w) => ready([], { runtimeErrors: w === 390 ? [long('a'), long('b')] : [long('a')] }, w)), { offset: 0, total: 1 });
    expect((d.content.runtimeErrors as Array<{ in: string[] }>).map((e) => e.in)).toEqual([['defaults: phone, desktop'], ['defaults: phone']]);
    expect(d.content.summary).toMatch(/^Offer card: 2 problems found/);
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
    const at = (node: string, n = 0, of = 1, items = '') => ({ ctx, node, items, n, of });
    const gap = (a: ReturnType<typeof at>, b: ReturnType<typeof at>, g: number) => ({ a, b, gap: g });
    const cases: InspectCase[] = [
      { label: 'filled', variants: {}, props: {} },
      { label: 'empty', variants: {}, props: {}, control: 'filled' }
    ];
    /** The digest of the two cases, with gaps for each width (the same at both unless `desktop` says otherwise). */
    const digest = (control: unknown[], empty: unknown[], desktop?: { control?: unknown; empty?: unknown; gapsIncomplete?: boolean }) =>
      digestComponentInspection(
        target(),
        cases,
        resultsFor(cases, (label, w) => (w === 1280 && desktop ? ready([], { gaps: label === 'empty' ? (desktop.empty ?? empty) : (desktop.control ?? control), ...(desktop.gapsIncomplete ? { gapsIncomplete: true } : {}) }, w) : ready([], { gaps: label === 'empty' ? empty : control }, w))),
        { offset: 0, total: 2 }
      ).content;

    it('finds two elements that touch once what carried the space between them is gone', () => {
      // Heading, button row (24px above and below it), list; with the links empty the row is gone. At desktop width
      // the container keeps them apart.
      const found = digest([gap(at('h'), at('row'), 24), gap(at('row'), at('list'), 24)], [gap(at('h'), at('list'), 0)], { empty: [gap(at('h'), at('list'), 24)] });
      expect(found.findings).toEqual([expect.objectContaining({ kind: 'spacing-collapse', at: { nodeId: 'h', partId: 'title' }, with: { at: { nodeId: 'list', partId: 'root', match: 'nearest-part' } }, in: ['empty: phone'] })]);
      expect((found.findings as Array<{ message: string }>)[0].message).toContain('at least 24px');
      expect(digest([gap(at('h'), at('row'), 8), gap(at('row'), at('list'), 8)], [gap(at('h'), at('list'), 1)]).findings).toHaveLength(1);
      // Two elements gone from between them.
      expect(digest([gap(at('h'), at('row'), 16), gap(at('row'), at('e'), 0), gap(at('e'), at('list'), 16)], [gap(at('h'), at('list'), 0)]).findings).toBeUndefined();
      expect(digest([gap(at('h'), at('row'), 16), gap(at('row'), at('e'), 16), gap(at('e'), at('list'), 16)], [gap(at('h'), at('list'), 0)]).findings).toHaveLength(1);
    });

    it('finds a gap between the same two elements that closed', () => {
      expect(digest([gap(at('h'), at('list'), 16)], [gap(at('h'), at('list'), 0)]).findings).toEqual([expect.objectContaining({ kind: 'spacing-collapse', with: { at: expect.objectContaining({ nodeId: 'list' }) }, in: ['empty: phone, desktop'] })]);
    });

    it('leaves alone spacing that stays, elements that touched already, and something still between them', () => {
      // The container's gap keeps them apart, or they are only a little closer.
      expect(digest([gap(at('h'), at('row'), 16), gap(at('row'), at('list'), 16)], [gap(at('h'), at('list'), 16)]).findings).toBeUndefined();
      expect(digest([gap(at('h'), at('row'), 7), gap(at('row'), at('list'), 24)], [gap(at('h'), at('list'), 0)]).findings).toBeUndefined();
      expect(digest([gap(at('h'), at('row'), 24), gap(at('row'), at('list'), 24)], [gap(at('h'), at('list'), 2)]).findings).toBeUndefined();
      // They touched the row before, on either side.
      expect(digest([gap(at('h'), at('row'), 0), gap(at('row'), at('list'), 24)], [gap(at('h'), at('list'), 0)]).findings).toBeUndefined();
      expect(digest([gap(at('h'), at('row'), 24), gap(at('row'), at('list'), 0)], [gap(at('h'), at('list'), 0)]).findings).toBeUndefined();
      // The row is still there, so the heading and the list were never neighbours.
      expect(digest([gap(at('h'), at('row'), 24), gap(at('row'), at('list'), 24)], [gap(at('h'), at('list'), 0), gap(at('row'), at('e'), 0)]).findings).toBeUndefined();
    });

    it('tells repeated rows apart by the list item they show, and skips rows outside a list whose count changed', () => {
      // Two cards' action rows: card a's row is gone (it held only a link), card b's stays.
      const row = (item: string) => at('row', 0, 1, item);
      const control = [gap(at('h', 0, 1, 'a'), row('a'), 24), gap(row('a'), at('p', 0, 1, 'a'), 24), gap(at('h', 0, 1, 'b'), row('b'), 24), gap(row('b'), at('p', 0, 1, 'b'), 24)];
      const empty = [gap(at('h', 0, 1, 'a'), at('p', 0, 1, 'a'), 0), gap(at('h', 0, 1, 'b'), row('b'), 24), gap(row('b'), at('p', 0, 1, 'b'), 24)];
      expect(digest(control, empty).findings).toEqual([expect.objectContaining({ kind: 'spacing-collapse', at: { nodeId: 'h', partId: 'title' }, in: ['empty: phone, desktop'] })]);
      // Three rows of one design node outside a list; the first is gone, so the other two are now 0 and 1.
      expect(digest([gap(at('row', 0, 3), at('row', 1, 3), 16), gap(at('row', 1, 3), at('row', 2, 3), 0)], [gap(at('row', 0, 2), at('row', 1, 2), 0)]).findings).toBeUndefined();
      // Only one end's count changed: still not a comparison of the same elements.
      expect(digest([gap(at('h'), at('row', 0, 2), 16), gap(at('row', 0, 2), at('list'), 16)], [gap(at('h'), at('list'), 0)]).findings).toHaveLength(1);
      expect(digest([gap(at('h', 0, 2), at('row'), 16), gap(at('row'), at('list'), 16)], [gap(at('h', 0, 1), at('list'), 0)]).findings).toBeUndefined();
    });

    it('says the spacing was not compared when either side has no gaps to compare', () => {
      const out = digest([gap(at('h'), at('list'), 16)], [gap(at('h'), at('list'), 0)], { gapsIncomplete: true });
      expect(out.findings).toEqual([expect.objectContaining({ in: ['empty: phone'] })]);
      expect(out.summary).toContain('could not be compared at desktop width');
      expect(out.incomplete).toBe(true);
    });
  });
});
