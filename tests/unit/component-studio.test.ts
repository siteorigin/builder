import { describe, expect, it, vi } from 'vitest';
import type { ElementRef, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { installComponent, makeInstance } from '@engine/install';
import { generateComponentPreview } from '@generator/preview';
import { PREVIEW_MODULE } from '@shared/component-preview';
import { descOf, listPropFor, needsStudio, refExists, studioRef, studioCtx, studioDescOf, studioDesignCtx, studioPick, designCtx, type BridgeDesc } from '../../src/renderer/src/lib/model';
import { NEW_STUDIO, StudioLoads, studioSpec, studioStates, studioVariants } from '../../src/renderer/src/lib/studio';
import { applyOperations } from '@engine/apply';
import { defFile, generateProject } from '@generator/index';

const starter = () => createStarterState('blank', 'Studio Test', false);
const own = (id: string) => ({ kind: 'component' as const, id });

/** A theme component installed in a blank project, unplaced, and its own nodes. */
function design(componentId: string) {
  const state = starter();
  const id = installComponent(state, componentId);
  const def = state.components[id];
  return { state, id, def, nodes: Object.values(def.tree!.nodes) };
}

/** A design with another managed component placed inside it, as the last child of its root element. */
function nestingDesign(): { state: ProjectState; id: string; nested: string } {
  const state = starter();
  const id = installComponent(state, 'features.grid');
  const inner = state.components[installComponent(state, 'content.media')];
  const def = state.components[id];
  const root = def.tree!.nodes[def.tree!.rootIds[0]];
  if (root.kind !== 'element' || inner.kind !== 'managed' || !inner.tree) throw new Error('Unexpected fixture');
  const node = makeInstance(inner);
  def.tree!.nodes[node.id] = node;
  root.children.push(node.id);
  return { state, id, nested: node.id };
}

describe('Component Studio: the design in the isolated preview', () => {
  it('renders the design under the context the studio maps', () => {
    const { state, id, def } = design('features.grid');
    const out = generateComponentPreview(state, { definitionId: id });
    if ('error' in out) throw new Error(out.error);
    // The preview passes the design's context to its one instance; the design's own nodes carry it.
    expect(studioCtx(id)).toBe(`preview:${id}|preview`);
    expect(out.files.get(PREVIEW_MODULE)).toContain(`__so={${JSON.stringify(`preview:${id}|preview`)}}`);
    expect(studioDescOf(state, id, { owner: own(id), instancePath: [], nodeId: def.tree!.rootIds[0] })).toEqual({ ctx: studioCtx(id), node: def.tree!.rootIds[0], items: '' });
  });

  it('picks the design’s own nodes and gives back the same reference for each', () => {
    const { state, id, def, nodes } = design('features.grid');
    for (const n of nodes) {
      const ref: ElementRef = { owner: own(id), instancePath: [], nodeId: n.id };
      const desc = studioDescOf(state, id, ref)!;
      // The bridge reports the chain innermost first: what is not the design's (a page's markup) is passed over.
      const picked = studioPick(state, id, [{ ctx: `page:${state.site.homePageId}`, node: n.id, items: '' }, desc]);
      // A component placed in the design is picked whole, by its own root: the same node of the design.
      expect(picked?.nodeId).toBe(n.id);
      expect(picked?.owner).toEqual(own(id));
      expect(picked?.instancePath).toEqual([]);
      const part = Object.entries(def.parts).find(([, p]) => p.nodeId === n.id)?.[0];
      expect(picked?.partId).toBe(part);
    }
  });

  it('keeps an item of the design’s own list, and lets go of one only the sample content has', () => {
    const { state, id, def, nodes } = design('features.grid');
    const repeated = nodes.find((n) => listPropFor(def, n.id));
    expect(repeated).toBeDefined();
    const list = def.properties[listPropFor(def, repeated!.id)!];
    const itemId = (list.default as Array<{ id: string }>)[0].id;
    const desc = studioDescOf(state, id, { owner: own(id), instancePath: [], nodeId: repeated!.id, itemPath: [itemId] })!;
    expect(desc.items).toBe(descOf(state, { owner: own(id), instancePath: [], nodeId: repeated!.id, itemPath: [itemId] }).items);
    const kept = studioPick(state, id, [desc])!;
    expect(kept.itemPath).toEqual([itemId]);
    expect(refExists(state, kept)).toBe(true);
    const sample = studioPick(state, id, [{ ...desc, items: `${itemId}-sample-3` }])!;
    expect(sample.itemPath).toBeUndefined();
    expect(sample.nodeId).toBe(repeated!.id);
    // One a placement names is the placement's: the preview never shows it, even though the project has it.
    const placed = makeInstance(def);
    const placedId = ((placed.props[listPropFor(def, repeated!.id)!] as Array<{ id: string }>)[0]).id;
    state.pages[state.site.homePageId].nodes[placed.id] = placed;
    state.pages[state.site.homePageId].rootIds.push(placed.id);
    const elsewhere: ElementRef = { owner: own(id), instancePath: [], nodeId: repeated!.id, itemPath: [placedId] };
    expect(refExists(state, elsewhere)).toBe(true);
    expect(studioPick(state, id, [studioDescOf(state, id, elsewhere)!])!.itemPath).toBeUndefined();
    expect(studioRef(state, id, elsewhere).itemPath).toBeUndefined();
    expect(studioRef(state, id, kept)).toBe(kept);
    // An item inside another list's item may sit in an item only a sample has: let go, so it is outlined in every item.
    expect(studioRef(state, id, { ...kept, itemPath: [`${itemId}-sample-3`, itemId] }).itemPath).toBeUndefined();
  });

  it('picks a component inside the design whole, from anything inside it, and outlines its parts through it', () => {
    const { state, id, nested } = nestingDesign();
    const inner = state.components[(state.components[id].tree!.nodes[nested] as { definitionId: string }).definitionId];
    const deep = Object.keys(inner.tree!.nodes).find((k) => k !== inner.tree!.rootIds[0]) ?? inner.tree!.rootIds[0];
    const chain: BridgeDesc[] = [{ ctx: `${studioCtx(id)}|${nested}`, node: deep, items: '' }];
    expect(studioPick(state, id, chain)).toMatchObject({ owner: own(id), instancePath: [], nodeId: nested });
    // A part of it chosen in Layers is found inside the nested component's own markup.
    const part: ElementRef = { owner: own(id), instancePath: [nested], nodeId: deep };
    expect(studioDescOf(state, id, part)).toEqual({ ctx: `${studioCtx(id)}|${nested}`, node: deep, items: '' });
    expect(studioDesignCtx(state, id, part)).toBe(designCtx(state, part).replace(`component:${id}`, studioCtx(id)));
  });

  it('picks the innermost of the design’s own nodes the bridge reports', () => {
    const { state, id, def, nodes } = design('features.grid');
    const root = def.tree!.rootIds[0];
    const inner = nodes.find((n) => n.id !== root && !listPropFor(def, n.id))!;
    const chain = [inner.id, root].map((nodeId) => studioDescOf(state, id, { owner: own(id), instancePath: [], nodeId })!);
    expect(studioPick(state, id, chain)?.nodeId).toBe(inner.id);
  });

  it('ignores the page, other components and the code wrapper', () => {
    const { state, id, def } = design('features.grid');
    const root = def.tree!.rootIds[0];
    expect(studioPick(state, id, [{ ctx: `page:${state.site.homePageId}`, node: root, items: '' }])).toBeNull();
    expect(studioPick(state, id, [{ ctx: 'preview:other|preview', node: root, items: '' }])).toBeNull();
    expect(studioPick(state, id, [{ ctx: `${studioCtx(id)}x`, node: root, items: '' }])).toBeNull();
    expect(studioPick(state, id, [{ ctx: `preview:${id}`, node: 'preview', items: '', code: true }])).toBeNull();
    expect(studioPick(state, id, [{ ctx: studioCtx(id), node: 'gone', items: '' }])).toBeNull();
    // Only the edited component's own references are shown.
    expect(studioDescOf(state, id, { owner: { kind: 'page', id: state.site.homePageId }, instancePath: [], nodeId: root })).toBeNull();
    expect(studioDescOf(state, 'other', { owner: own(id), instancePath: [], nodeId: root })).toBeNull();
  });
});

describe('Component Studio: when editing everywhere needs it', () => {
  it('shows a component the page no longer places on its own, and leaves one placed there on the page', () => {
    const { state, id } = design('features.grid');
    // The project's own copy, as Edit everywhere makes one.
    state.components[id] = { ...state.components[id], owner: 'project' };
    const theme = state.components[installComponent(state, 'content.media')];
    const home = state.site.homePageId;
    const placed = makeInstance(state.components[id]);
    const page = state.pages[home];
    expect(needsStudio(state, { definitionId: id, returnPageId: home }, home)).toBe(true);
    page.nodes[placed.id] = placed;
    page.rootIds.push(placed.id);
    expect(needsStudio(state, { definitionId: id, returnPageId: home }, home)).toBe(false);
    // Another page, which does not place it, while Home still does.
    const other = { ...page, id: 'other', route: '/other/', title: 'Other', nodes: {}, rootIds: [] };
    state.pages.other = other;
    expect(needsStudio(state, { definitionId: id, returnPageId: home }, 'other')).toBe(true);
    // Already in the studio, not editing, no page, or a theme's original: nothing to do.
    expect(needsStudio(state, { definitionId: id, returnPageId: home, studio: NEW_STUDIO }, home)).toBe(false);
    expect(needsStudio(state, null, home)).toBe(false);
    expect(needsStudio(state, { definitionId: id, returnPageId: home }, null)).toBe(true);
    expect(theme.owner).toBe('theme');
    expect(needsStudio(state, { definitionId: theme.id, returnPageId: home }, home)).toBe(false);
  });
});

describe('Component Studio: what it shows', () => {
  it('shows the chosen option on each axis, the look being styled on its own, and the default for one gone', () => {
    const { def } = design('features.grid');
    const [[axis, a]] = Object.entries(def.variantAxes!);
    const other = Object.keys(a.options).find((o) => o !== a.default)!;
    expect(studioSpec(def, NEW_STUDIO)).toEqual({ definitionId: def.id });
    expect(studioSpec(def, { ...NEW_STUDIO, variants: { [axis]: other } })).toEqual({ definitionId: def.id, variants: { [axis]: other } });
    // An option removed since (an Undo) falls back to the default, and the request is the plain one again.
    expect(studioSpec(def, { ...NEW_STUDIO, variants: { [axis]: 'gone', nope: 'x' } })).toEqual({ definitionId: def.id });
    // Styling a look shows it, whatever the toolbar says for that axis; another component's look changes nothing.
    expect(studioVariants(def, { ...NEW_STUDIO, variants: { [axis]: a.default } }, { definitionId: def.id, axis, variant: other })[axis]).toBe(other);
    expect(studioVariants(def, NEW_STUDIO, { definitionId: 'other', axis, variant: other })[axis]).toBe(a.default);
    // Sample content goes with the request; the design is never changed.
    const before = JSON.stringify(def);
    expect(studioSpec(def, { ...NEW_STUDIO, sample: 'long' }).props).toBeDefined();
    expect(JSON.stringify(def)).toBe(before);
  });
});

describe('Component Studio: the previews its frame is given', () => {
  it('shows only the latest request, and releases every other preview', () => {
    const release = vi.fn();
    const loads = new StudioLoads(release);
    const a = loads.begin();
    const b = loads.begin();
    // B is prepared first and shown; A, older, arrives late and is let go at once.
    expect(loads.prepared(b, 'keyb')).toBe(true);
    expect(loads.prepared(a, 'keya')).toBe(false);
    expect(release.mock.calls).toEqual([['keya']]);
    expect(loads.shows('keyb')).toBe(true);
    expect(loads.shows('keya')).toBe(false);
    expect(loads.shows(undefined)).toBe(false);
    // The next one replaces it in the frame, and the one it replaces goes.
    const c = loads.begin();
    expect(loads.latest(c)).toBe(true);
    expect(loads.latest(b)).toBe(false);
    expect(loads.prepared(c, 'keyc')).toBe(true);
    expect(release.mock.calls).toEqual([['keya'], ['keyb']]);
    // Closing releases what is shown, and a request still being prepared is out of date.
    const d = loads.begin();
    loads.end();
    expect(release.mock.calls).toEqual([['keya'], ['keyb'], ['keyc']]);
    expect(loads.prepared(d, 'keyd')).toBe(false);
    expect(release.mock.calls.at(-1)).toEqual(['keyd']);
    expect(loads.shows('keyc')).toBe(false);
  });

  it('lets go of a request made out of date with no new one, and keeps what the frame shows', () => {
    const release = vi.fn();
    const loads = new StudioLoads(release);
    expect(loads.prepared(loads.begin(), 'shown')).toBe(true);
    const pending = loads.begin();
    // An inline edit opens: the request on its way is out of date, and the frame keeps its preview.
    loads.supersede();
    expect(loads.latest(pending)).toBe(false);
    expect(loads.prepared(pending, 'late')).toBe(false);
    expect(release.mock.calls).toEqual([['late']]);
    expect(loads.shows('shown')).toBe(true);
  });
});

/** A design with a Monthly/Annual choice (tabs) and a yes/no state opening a drawer, made as the editor makes one. */
function stateful(): { state: ProjectState; id: string } {
  const none = { type: 'none' as const, target: '' };
  const made = applyOperations(starter(), [
    {
      type: 'component.upsert',
      name: 'Plan switch',
      properties: {},
      state: { plan: { type: 'enum', label: 'Plan', options: ['monthly', 'annual'] }, open: { type: 'boolean', label: 'Details', initial: true } },
      nodes: [
        { kind: 'element', id: 'root', tag: 'section', children: ['tabs', 'monthly', 'annual', 'more', 'drawer'] },
        { kind: 'element', id: 'tabs', children: ['monthlyTab', 'annualTab'] },
        { kind: 'link', id: 'monthlyTab', link: none, label: 'Monthly', stateAction: { state: 'plan', op: 'set', value: 'monthly' } },
        { kind: 'link', id: 'annualTab', link: none, label: 'Annual', stateAction: { state: 'plan', op: 'set', value: 'annual' } },
        { kind: 'element', id: 'monthly', children: [], when: { ref: { $state: 'plan' }, eq: 'monthly' } },
        { kind: 'element', id: 'annual', children: [], when: { ref: { $state: 'plan' }, eq: 'annual' } },
        { kind: 'link', id: 'more', link: none, label: 'Details', stateAction: { state: 'open', op: 'toggle' } },
        { kind: 'element', id: 'drawer', overlay: 'drawer-end', children: [], when: { $state: 'open' } }
      ]
    }
  ]);
  return { state: made.state, id: made.results[0].definitionId as string };
}

describe('Component Studio: UI state (#377)', () => {
  it('previews each state at the author’s value while the state can hold it, and asks only for what differs from the start', () => {
    const { state, id } = stateful();
    const def = state.components[id];
    expect(studioStates(def, NEW_STUDIO)).toEqual({ plan: 'monthly', open: true });
    expect(studioSpec(def, NEW_STUDIO)).toEqual({ definitionId: id });
    expect(studioSpec(def, { ...NEW_STUDIO, states: { plan: 'annual' } })).toEqual({ definitionId: id, states: { plan: 'annual' } });
    // Off is a value of its own, asked for when the design starts on.
    expect(studioSpec(def, { ...NEW_STUDIO, states: { open: false } })).toEqual({ definitionId: id, states: { open: false } });
    // An option or a state gone since (an Undo), or a value of the wrong kind, shows where the design starts.
    expect(studioSpec(def, { ...NEW_STUDIO, states: { plan: 'lifetime', gone: true, open: 'yes' as never } })).toEqual({ definitionId: id });
    expect(studioStates({ ...def, state: { plan: { type: 'enum', label: 'Plan', options: [], initial: 'x' } as never } }, NEW_STUDIO)).toEqual({});
  });

  it('generates the preview from a copy starting at the previewed values, showing an open drawer in place while editing', () => {
    const { state, id } = stateful();
    const before = JSON.stringify(state.components[id]);
    const out = generateComponentPreview(state, { definitionId: id, states: { plan: 'annual', open: true } });
    if ('error' in out) throw new Error(out.error);
    const file = out.files.get(defFile(state.components[id]))!;
    expect(file).toContain('let so_state_plan = $state("annual");');
    expect(file).toContain('let so_state_open = $state(true);');
    // The drawer is marked open in place, and the editor's own Show to edit button steps aside while it is.
    expect(file).toContain(`data-so-overlay-open={so_state_open ? '' : undefined}`);
    expect(file).toMatch(/\{#if !\(so_state_open\)\}\s*<button type="button" class="so-overlay-peek"/);
    expect(JSON.stringify(state.components[id])).toBe(before);
    expect(generateComponentPreview(state, { definitionId: id, states: { period: 'annual' } })).toEqual({ error: '"Plan switch" has no UI state "period".' });
    expect(generateComponentPreview(state, { definitionId: id, states: { plan: 'weekly' } })).toEqual({ error: '"Plan switch" → Plan: "weekly" is not one of its values.' });
    expect(generateComponentPreview(state, { definitionId: id, states: { open: 'yes' } })).toEqual({ error: '"Plan switch" → Details: "yes" is not one of its values.' });
    // A page's placements keep the author's own Show to edit: the project's editor and site variants never mark one open.
    for (const instrument of [true, false]) expect([...generateProject(state, { instrument }).values()].some((f) => f.includes('data-so-overlay-open'))).toBe(false);
  });
});
