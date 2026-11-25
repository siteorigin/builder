/**
 * The assistant and newer theme versions of installed components (#692): it reads what a newer version adds and
 * whether the project can take it, updates only the component a request needs (in the turn report, undone with the
 * turn, within the run's scope), then makes the change; a held update is explained, never taken.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiEvent, ChatContext } from '@shared/api';
import type { ElementRef, InstanceNode, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { getTheme } from '@catalogue/index';
import { header as HEADER_DEF } from '@catalogue/foundation/shell';
import { definitionHash } from '@shared/migrations';
import { applyOperations } from '@engine/apply';
import { themeUpdates } from '@engine/theme-updates';
import { Orchestrator } from '@agent/orchestrator';
import type { AgentModelAdapter, CanonicalModelRequest, ModelEvent } from '@agent/types';
import { executeTool, toolsForRun, type ToolHost } from '@agent/tools';
import { checkAuthority, type Authority } from '@agent/scope';
import { describeSelection, projectSummary } from '@agent/context';
import { themeUpdateChanges } from '@agent/theme-update';
import { describeOps } from '@agent/report';
import { ProjectSession } from '../../src/main/project/session';

const HEADER = HEADER_DEF.id;
const current = (id: string) => getTheme('foundation').components.find((c) => c.id === id)!;
const headerNode = (s: ProjectState) => s.site.shell.header.nodes[s.site.shell.header.rootIds[0]] as InstanceNode;
const HERO = 'foundation.hero.split';

/**
 * A project made before the header had its Action style: neither the installed header nor its placement has ctaStyle,
 * and the lock still says the header is the theme's own. `hero` ages the hero too, so an update can be shown targeted.
 */
function beforeActionStyle(opts: { held?: boolean; hero?: boolean } = {}): ProjectState {
  const s = structuredClone(createStarterState('business', 'Test', false));
  const header = s.components[HEADER];
  delete (header.properties as Record<string, unknown>).ctaStyle;
  delete headerNode(s).props.ctaStyle;
  if (!opts.held) s.themeLock.components[HEADER].hash = definitionHash(header);
  if (opts.hero && s.components[HERO]) {
    s.components[HERO].description = 'An older description';
    s.themeLock.components[HERO].hash = definitionHash(s.components[HERO]);
  }
  return s;
}

/** A host over a project in memory, checking each batch against the run's authority as the orchestrator does. */
function host(start: ProjectState, authority: Authority = { kind: 'site' }) {
  let state = start;
  let revision = 1;
  const applied: EditOperation[][] = [];
  const h: ToolHost = {
    state: () => state,
    revision: () => revision,
    diagnostics: () => [],
    apply: async (ops, expected, _label, _key, grants) => {
      if (expected !== revision) return { ok: false, revision, error: { code: 'STALE_REVISION', message: 'stale' } };
      const denied = checkAuthority(state, ops, authority, grants);
      if (denied) return { ok: false, revision, error: { code: 'SCOPE_MISMATCH', message: denied } };
      try {
        const r = applyOperations(state, ops);
        state = r.state;
        revision++;
        applied.push(ops);
        return { ok: true, revision, results: r.results };
      } catch (e) {
        return { ok: false, revision, error: { code: 'VALIDATION_FAILED', message: (e as Error).message } };
      }
    },
    compileAll: async () => [],
    inspectLayout: async () => ({}),
    ask: async () => ''
  };
  return { h, applied, now: () => state };
}

const tool = (h: ToolHost, name: string, args: unknown) => executeTool(name, JSON.stringify(args), h, `call_${name}`);
/** The definitionIds an offered update tool takes, or null when it is not offered. */
const enumOf = (t: { parameters: unknown } | undefined) => (t ? (t.parameters as { properties: { definitionId: { enum: string[] } } }).properties.definitionId.enum : null);
const names = (tools: Array<{ name: string }>) => tools.map((t) => t.name);

describe('what a newer theme version adds', () => {
  it('names the header’s Action style with its stored values and the labels the author sees', () => {
    const s = beforeActionStyle();
    const adds = themeUpdateChanges(s.components[HEADER], current(HEADER));
    expect(adds).toEqual({ properties: { ctaStyle: { label: 'Action style', type: 'enum', options: { primary: 'Filled button', secondary: 'Outlined button' } } } });
    // Nothing new is nothing to add.
    expect(themeUpdateChanges(current(HEADER), current(HEADER))).toEqual({});
  });

  it('lists new options, item fields, parts, style controls, variants and slots', () => {
    const was = structuredClone(current(HERO));
    const next = structuredClone(was);
    const [prop, schema] = Object.entries(next.properties).find(([, p]) => p.type === 'enum')! as [string, Extract<(typeof next.properties)[string], { type: 'enum' }>];
    schema.options = [...schema.options, { value: 'extra', label: 'Extra choice' }];
    next.parts = { ...next.parts, badge: { nodeId: next.tree!.rootIds[0], label: 'Badge' } };
    next.slots = { ...next.slots, aside: { label: 'Aside' } };
    next.variantAxes = { ...next.variantAxes, density: { label: 'Density', default: 'roomy', options: { roomy: { label: 'Roomy' }, tight: { label: 'Tight' } } } } as never;
    // A property whose type changed is offered as new, and so is a new field of a list's items, with its choices.
    const [text] = Object.entries(next.properties).find(([, p]) => p.type === 'string')!;
    next.properties[text] = { type: 'boolean', label: 'Now a switch', default: false } as never;
    const adds = themeUpdateChanges(was, next);
    expect(adds.properties?.[text]).toEqual({ label: 'Now a switch', type: 'boolean' });
    // A grid's cards gain a field, with its choices.
    const grid = structuredClone(current('foundation.features.grid'));
    const newer = structuredClone(grid);
    const [list, listSchema] = Object.entries(newer.properties).find(([, p]) => p.type === 'list' && !p.feed)!;
    (listSchema as { fields: Record<string, unknown> }).fields.tone = { type: 'enum', label: 'Tone', default: 'calm', options: [{ value: 'calm', label: 'Calm' }, { value: 'loud', label: 'Loud' }] };
    expect(themeUpdateChanges(grid, newer).fields).toEqual({ [`${list}.tone`]: { type: 'enum', label: 'Tone', options: { calm: 'Calm', loud: 'Loud' } } });
    expect(adds.options).toEqual({ [prop]: { extra: 'Extra choice' } });
    expect(adds.parts).toEqual({ badge: 'Badge' });
    expect(adds.slots).toEqual({ aside: 'Aside' });
    expect(adds.variants).toEqual({ density: { roomy: 'Roomy', tight: 'Tight' } });
  });

  it('counts a style control as new only where the installed part had a list that lacked it', () => {
    const next = current(HERO);
    const [partId, part] = Object.entries(next.parts).find(([, p]) => (p.styleControls?.length ?? 0) > 1)!;
    const dropped = part.styleControls!.find((c) => c !== 'background' && c !== 'aspectRatio')!;
    const older = structuredClone(next);
    older.parts[partId].styleControls = part.styleControls!.filter((c) => c !== dropped);
    expect(themeUpdateChanges(older, next).styleControls).toEqual({ [partId]: [dropped] });
    // A part that offered every control gains none from a list of its own.
    const open = structuredClone(next);
    delete open.parts[partId].styleControls;
    expect(themeUpdateChanges(open, next).styleControls).toBeUndefined();
  });
});

describe('where the assistant reads it', () => {
  it('lists the update in the project summary, and beside the header in read_component, inspect_element and a selection', async () => {
    const s = beforeActionStyle();
    const summary = projectSummary(s, 1) as { themeUpdates?: { available?: Array<{ definitionId: string; adds: string[] }> } };
    const entry = summary.themeUpdates?.available?.find((a) => a.definitionId === HEADER);
    expect(entry?.adds.join(' ')).toContain('Outlined button');
    const { h } = host(s);
    const read = await tool(h, 'read_component', { componentId: 'shell.header' });
    const content = read.content as { properties: Record<string, unknown>; themeUpdate?: { status: string; newVersionAdds: { properties: Record<string, unknown> } } };
    // The installed contract stays the installed one: its Action style comes only with the update.
    expect(content.properties.ctaStyle).toBeUndefined();
    expect(content.themeUpdate?.status).toBe('available');
    expect(content.themeUpdate?.newVersionAdds.properties.ctaStyle).toMatchObject({ options: { secondary: 'Outlined button' } });
    const inspected = await tool(h, 'inspect_element', { owner: { kind: 'shell', id: 'header' }, nodeId: headerNode(s).id });
    expect((inspected.content as { themeUpdate?: unknown }).themeUpdate).toMatchObject({ status: 'available', newVersionAdds: { properties: { ctaStyle: { options: { secondary: 'Outlined button' } } } } });
    for (const ref of [
      { owner: { kind: 'shell', id: 'header' }, nodeId: headerNode(s).id, instancePath: [] },
      { owner: { kind: 'shell', id: 'header' }, nodeId: 'root', instancePath: [headerNode(s).id], partId: 'root' }
    ] as ElementRef[])
      expect((describeSelection(s, ref) as { themeUpdate?: { status: string } }).themeUpdate?.status).toBe('available');
  });

  it('keeps the summary short: nothing to add is not listed as an addition, and a long list says how many more', () => {
    const s = beforeActionStyle({ hero: true });
    const summary = projectSummary(s, 1) as unknown as { themeUpdates: { available: Array<{ definitionId: string; adds?: string[] }> } };
    // The hero's newer version changes only its description: nothing a request could ask for.
    expect(summary.themeUpdates.available.find((a) => a.definitionId === HERO)).toEqual({ definitionId: HERO, name: s.components[HERO].name });
    // Every theme component a version behind, as in a project made a while ago.
    const old = structuredClone(s);
    for (const d of Object.values(old.components)) {
      if (d.owner !== 'theme') continue;
      d.description = `${d.description ?? ''} (older)`;
      old.themeLock.components[d.id].hash = definitionHash(d);
    }
    const all = themeUpdates(old).available.length;
    expect(all).toBeGreaterThan(12);
    const long = projectSummary(old, 1) as unknown as { themeUpdates: { available: unknown[]; moreAvailable?: number } };
    expect(long.themeUpdates.available).toHaveLength(12);
    expect(long.themeUpdates.moreAvailable).toBe(all - 12);
  });

  it('says nothing for a project whose components are all current', async () => {
    const s = createStarterState('business', 'Test', false);
    expect(projectSummary(s, 1)).not.toHaveProperty('themeUpdates');
    const read = await tool(host(s).h, 'read_component', { componentId: 'shell.header' });
    expect(read.content).not.toHaveProperty('themeUpdate');
    expect(names(toolsForRun({ state: s, selection: null, capabilities: { toolCalling: 'native', contextWindowTokens: 200000 }, codeEnabled: false, definitionOps: false }).tools)).not.toContain('update_theme_component');
  });

  it('describes a held update with its reason and what it would add, and offers no update of it', async () => {
    const s = beforeActionStyle({ held: true });
    expect(themeUpdates(s).kept.find((k) => k.id === HEADER)?.reason).toMatch(/changed outside the theme/);
    const summary = projectSummary(s, 1) as unknown as { themeUpdates?: { held?: Array<{ definitionId: string; reason: string; adds: string[] }> } };
    const held = summary.themeUpdates?.held?.find((k) => k.definitionId === HEADER);
    expect(held?.reason).toMatch(/changed outside the theme/);
    expect(held?.adds.join(' ')).toContain('Outlined button');
    const read = await tool(host(s).h, 'read_component', { componentId: 'shell.header' });
    const note = (read.content as { themeUpdate?: { status: string; heldBecause: string; note: string } }).themeUpdate;
    expect(note?.status).toBe('held');
    expect(note?.heldBecause).toMatch(/changed outside the theme/);
    expect(note?.note).toMatch(/tell the user/);
    const run = toolsForRun({ state: s, selection: null, capabilities: { toolCalling: 'native', contextWindowTokens: 200000 }, codeEnabled: false, definitionOps: false });
    expect(names(run.tools)).not.toContain('update_theme_component');
    // Beside an update that can be taken, the held one is still never offered.
    const both = beforeActionStyle({ held: true, hero: true });
    const t = toolsForRun({ state: both, selection: null, capabilities: { toolCalling: 'native', contextWindowTokens: 200000 }, codeEnabled: false, definitionOps: false }).tools.find((x) => x.name === 'update_theme_component');
    expect(enumOf(t)).toEqual([HERO]);
  });

  it('names the updates of components inside a selected element, besides its own', () => {
    const s = beforeActionStyle({ hero: true });
    const home = s.site.homePageId;
    const hero = s.pages[home].rootIds.find((id) => (s.pages[home].nodes[id] as InstanceNode).definitionId === HERO)!;
    // The hero moved into a container of its own: selecting the container says the hero inside it has an update.
    const ins = applyOperations(s, [{ type: 'node.insert', owner: { kind: 'page', id: home }, parentId: null, index: 0, primitive: 'container' } as EditOperation]);
    const box = (ins.results[0] as { nodeId: string }).nodeId;
    const moved = applyOperations(ins.state, [{ type: 'node.move', owner: { kind: 'page', id: home }, nodeId: hero, parentId: box, index: 0 }]).state;
    const sel = describeSelection(moved, { owner: { kind: 'page', id: home }, nodeId: box, instancePath: [] } as ElementRef) as { themeUpdatesInside?: { available?: Array<{ definitionId: string }> } };
    expect(sel.themeUpdatesInside?.available?.map((a) => a.definitionId)).toEqual([HERO]);
    // The header's own note is told apart, never twice.
    const header = describeSelection(moved, { owner: { kind: 'shell', id: 'header' }, nodeId: headerNode(moved).id, instancePath: [] } as ElementRef);
    expect(header).not.toHaveProperty('themeUpdatesInside');
  });
});

describe('update_theme_component', () => {
  it('updates the one component asked for, and returns its new contract', async () => {
    const s = beforeActionStyle({ hero: true });
    const { h, applied, now } = host(s);
    const out = await tool(h, 'update_theme_component', { definitionId: HEADER });
    expect(out.ok).toBe(true);
    expect(out.mutated).toBe(true);
    expect(applied).toEqual([[{ type: 'theme.refresh', definitionIds: [HEADER] }]]);
    expect((out.content as { component: { properties: Record<string, unknown> } }).component.properties.ctaStyle).toBeTruthy();
    expect(definitionHash(now().components[HEADER])).toBe(definitionHash(current(HEADER)));
    // Only the header: the hero the request did not need stays as it was.
    expect(themeUpdates(now()).available.map((u) => u.id)).toContain(HERO);
    expect(headerNode(now()).props.ctaLabel).toBe('Book a call');
  });

  it('explains a held update and changes nothing', async () => {
    const s = beforeActionStyle({ held: true });
    const { h, applied } = host(s);
    const out = await tool(h, 'update_theme_component', { definitionId: HEADER });
    expect(out.ok).toBe(false);
    expect(out.content).toMatchObject({ error: 'UPDATE_HELD', message: expect.stringMatching(/changed outside the theme/), newVersionAdds: { properties: { ctaStyle: expect.anything() } }, note: expect.stringMatching(/tell the user/) });
    expect(applied).toEqual([]);
  });

  it('refuses a component with no newer version, and a raw or bulk theme.refresh', async () => {
    const s = createStarterState('business', 'Test', false);
    const { h, applied } = host(s);
    expect((await tool(h, 'update_theme_component', { definitionId: HEADER })).content).toMatchObject({ message: expect.stringMatching(/no newer theme version/) });
    const edit = { type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: headerNode(s).id, prop: 'ctaLabel', value: 'Call us' };
    for (const ops of [[{ type: 'theme.refresh' }], [{ type: 'theme.refresh', definitionIds: [HEADER] }], [{ type: 'theme.refresh', definitionIds: [HEADER, HERO] }], [edit, { type: 'theme.refresh', definitionIds: [HEADER] }]]) {
      const raw = await tool(h, 'apply_operations', { expectedRevision: 1, operations: ops });
      expect(raw.content).toMatchObject({ error: 'INVALID_ARGUMENT', message: expect.stringMatching(/update_theme_component/) });
    }
    expect(applied).toEqual([]);
  });

  it('is offered with the components each run may update and then change, to small models and large, in edit runs only', () => {
    const s = beforeActionStyle({ hero: true });
    const big = { toolCalling: 'native' as const, contextWindowTokens: 200000 };
    const small = { toolCalling: 'constrained-json' as const, contextWindowTokens: 8000 };
    const offered = (capabilities: typeof big | typeof small, extra: Partial<Parameters<typeof toolsForRun>[0]> = {}) =>
      enumOf(toolsForRun({ state: s, selection: null, capabilities, codeEnabled: false, definitionOps: false, ...extra }).tools.find((x) => x.name === 'update_theme_component'))?.sort() ?? null;
    const header = { owner: { kind: 'shell' as const, id: 'header' }, nodeId: headerNode(s).id };
    // A whole-site run can change any placement; a small one's page tool changes a page's top-level sections, not the header.
    expect(offered(big)).toEqual([HEADER, HERO].sort());
    expect(offered(small)).toEqual([HERO]);
    // A selected header updates itself, never the hero elsewhere.
    expect(offered(big, { selection: header })).toEqual([HEADER]);
    expect(offered(small, { selection: header })).toEqual([HEADER]);
    // The home page holds the only hero; the header shows on every page.
    expect(offered(big, { page: { route: '/' } })).toEqual([HERO]);
    expect(offered(small, { page: { route: '/' } })).toEqual([HERO]);
    const about = s.site.pageOrder.map((id) => s.pages[id]).find((p) => p.id !== s.site.homePageId)!;
    expect(offered(big, { page: { route: about.route } })).toBeNull();
    // A part of the hero (its heading, say) never updates the hero; the whole hero does.
    const home = s.site.homePageId;
    const heroNode = s.pages[home].rootIds.find((id) => (s.pages[home].nodes[id] as InstanceNode).definitionId === HERO)!;
    const [partId] = Object.entries(s.components[HERO].parts).find(([, p]) => p.nodeId !== s.components[HERO].tree!.rootIds[0])!;
    expect(offered(big, { selection: { owner: { kind: 'page', id: home }, nodeId: heroNode, partId } })).toBeNull();
    expect(offered(small, { selection: { owner: { kind: 'page', id: home }, nodeId: heroNode } })).toEqual([HERO]);
    // A component's own design changes no placement, until the user lets the run change more.
    const target = { definitionId: HERO };
    expect(offered(big, { definition: true, definitionTarget: target })).toBeNull();
    expect(offered(big, { definition: true, definitionTarget: null })).toEqual([HEADER, HERO].sort());
    expect(offered(big, { ask: true })).toBeNull();
  });

  it('offers a small run a nested component only where its tools can change it', () => {
    const s = beforeActionStyle({ hero: true });
    const home = s.site.homePageId;
    const heroNode = s.pages[home].rootIds.find((id) => (s.pages[home].nodes[id] as InstanceNode).definitionId === HERO)!;
    const ins = applyOperations(s, [{ type: 'node.insert', owner: { kind: 'page', id: home }, parentId: null, index: 0, primitive: 'container' } as EditOperation]);
    const box = (ins.results[0] as { nodeId: string }).nodeId;
    const nested = applyOperations(ins.state, [{ type: 'node.move', owner: { kind: 'page', id: home }, nodeId: heroNode, parentId: box, index: 0 }]).state;
    const offered = (capabilities: { toolCalling: 'native' | 'constrained-json'; contextWindowTokens: number }, page?: { route: string }) =>
      enumOf(toolsForRun({ state: nested, selection: null, capabilities, codeEnabled: false, definitionOps: false, ...(page ? { page } : {}) }).tools.find((x) => x.name === 'update_theme_component')) ?? null;
    const big = { toolCalling: 'native' as const, contextWindowTokens: 200000 };
    const small = { toolCalling: 'constrained-json' as const, contextWindowTokens: 8000 };
    // The page tool changes top-level sections alone; the operations of a larger run reach the hero inside the container.
    expect(offered(big, { route: '/' })).toEqual([HERO]);
    expect(offered(small, { route: '/' })).toBeNull();
    expect(offered(big)).toContain(HERO);
    expect(offered(small)).toBeNull();
    // Widened from the nested hero, a small run keeps only its style tool for it: no tool of its sets what an update adds.
    const widened = toolsForRun({ state: nested, selection: null, widened: { owner: { kind: 'page', id: home }, nodeId: heroNode }, capabilities: small, codeEnabled: false, definitionOps: false });
    expect(enumOf(widened.tools.find((x) => x.name === 'update_theme_component'))).toBeNull();
  });

  it('offers no update to a part of a placement, as the run’s authority reads it', () => {
    const s = beforeActionStyle();
    const selection = { owner: { kind: 'shell' as const, id: 'header' }, nodeId: headerNode(s).id };
    const offered = (selectionPart?: boolean) =>
      enumOf(toolsForRun({ state: s, selection, capabilities: { toolCalling: 'native', contextWindowTokens: 200000 }, codeEnabled: false, definitionOps: false, ...(selectionPart === undefined ? {} : { selectionPart }) }).tools.find((x) => x.name === 'update_theme_component')) ?? null;
    expect(offered()).toEqual([HEADER]);
    expect(offered(false)).toEqual([HEADER]);
    expect(offered(true)).toBeNull();
  });

  it('gives a small selection run the new property to set once the header is updated', async () => {
    const s = beforeActionStyle();
    const selection = { owner: { kind: 'shell' as const, id: 'header' }, nodeId: headerNode(s).id };
    const small = { toolCalling: 'constrained-json' as const, contextWindowTokens: 8000 };
    const props = (state: ProjectState) => {
      const t = toolsForRun({ state, selection, capabilities: small, codeEnabled: false, definitionOps: false }).tools.find((x) => x.name === 'update_selected_props')!;
      return JSON.stringify(t.parameters);
    };
    expect(props(s)).not.toContain('ctaStyle');
    const { h, now } = host(s, { kind: 'selection', owner: selection.owner, nodeId: selection.nodeId, label: 'the header' });
    expect((await tool(h, 'update_theme_component', { definitionId: HEADER })).ok).toBe(true);
    expect(props(now())).toContain('ctaStyle');
    expect(props(now())).toContain('secondary');
  });
});

describe('scope of an update', () => {
  const refresh = (id: string): EditOperation[] => [{ type: 'theme.refresh', definitionIds: [id] }];

  it('lets a selected header update itself, but never through a raw, bulk or other component’s update', () => {
    const s = beforeActionStyle({ hero: true });
    const sel: Authority = { kind: 'selection', owner: { kind: 'shell', id: 'header' }, nodeId: headerNode(s).id, label: 'the header' };
    expect(checkAuthority(s, refresh(HEADER), sel, { themeRefresh: HEADER })).toBeNull();
    expect(checkAuthority(s, refresh(HEADER), sel)).toMatch(/more than the header/);
    expect(checkAuthority(s, refresh(HEADER), sel, { themeRefresh: HERO })).toMatch(/more than the header/);
    expect(checkAuthority(s, [{ type: 'theme.refresh' }], sel, { themeRefresh: HEADER })).toMatch(/more than the header/);
    // Two at once is never one update the tool asked for, even with one of them granted.
    expect(checkAuthority(s, [{ type: 'theme.refresh', definitionIds: [HEADER, HERO] }], sel, { themeRefresh: HEADER })).toMatch(/more than the header/);
    expect(checkAuthority(s, refresh(HERO), sel, { themeRefresh: HERO })).toMatch(/outside the header/);
    // A part of a placement never reaches its component's design.
    const part: Authority = { ...sel, part: { regionNodeId: 'root', partId: 'root' } };
    expect(checkAuthority(s, refresh(HEADER), part, { themeRefresh: HEADER })).toMatch(/more than the part/);
  });

  it('lets a page update a component placed only on it, and asks to widen for one placed elsewhere too', () => {
    const s = beforeActionStyle({ hero: true });
    const home = s.site.homePageId;
    const page: Authority = { kind: 'page', pageId: home, label: 'the Home page' };
    // The hero is placed on the home page alone; the header shows on every page.
    expect(checkAuthority(s, refresh(HERO), page, { themeRefresh: HERO })).toBeNull();
    expect(checkAuthority(s, refresh(HEADER), page, { themeRefresh: HEADER })).toMatch(/approve a wider change/);
    expect(checkAuthority(s, refresh(HERO), page)).toMatch(/more than the Home page/);
    const other = s.site.pageOrder.find((id) => id !== home)!;
    const copy = applyOperations(s, [{ type: 'node.insert', owner: { kind: 'page', id: other }, parentId: null, index: 0, componentId: 'hero.split' } as EditOperation]).state;
    expect(checkAuthority(copy, refresh(HERO), page, { themeRefresh: HERO })).toMatch(/approve a wider change/);
    // A component placed nowhere is no page's to update.
    const heroNode = s.pages[home].rootIds.find((id) => (s.pages[home].nodes[id] as InstanceNode).definitionId === HERO)!;
    const gone = applyOperations(s, [{ type: 'node.remove', owner: { kind: 'page', id: home }, nodeId: heroNode }]).state;
    expect(checkAuthority(gone, refresh(HERO), page, { themeRefresh: HERO })).toMatch(/approve a wider change/);
  });
});

describe('the turn report', () => {
  it('names the components an update changed', () => {
    const s = beforeActionStyle({ hero: true });
    const ops: EditOperation[] = [{ type: 'theme.refresh', definitionIds: [HEADER] }];
    const { state, results } = applyOperations(s, ops);
    expect(describeOps(ops, s, state, results).map((c) => c.label)).toEqual(["Updated the “Header” component to the theme's newer version"]);
    const both: EditOperation[] = [{ type: 'theme.refresh', definitionIds: [HEADER, HERO] }];
    const two = applyOperations(s, both);
    expect(describeOps(both, s, two.state, two.results).map((c) => c.label)).toEqual([`Updated the “Header” and “${s.components[HERO].name}” components to the theme's newer version`]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The whole request, through a scripted model (#692's acceptance)
// ---------------------------------------------------------------------------------------------------------------

type Turn = (req: CanonicalModelRequest) => ModelEvent[] | Promise<ModelEvent[]>;

class FakeAdapter implements AgentModelAdapter {
  requests: CanonicalModelRequest[] = [];
  constructor(
    private turns: Turn[],
    private caps: Partial<ReturnType<AgentModelAdapter['capabilities']>> = {}
  ) {}
  capabilities() {
    return { toolCalling: 'native' as const, streaming: true, strictSchemas: false, parallelToolCalls: true, contextWindowTokens: 100000, maxOutputTokens: 32000, ...this.caps } as ReturnType<AgentModelAdapter['capabilities']>;
  }
  async *streamTurn(req: CanonicalModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(structuredClone(req));
    const turn = this.turns.shift();
    if (!turn) {
      yield { type: 'done', stopReason: 'end', text: 'Done.', toolCalls: [] };
      return;
    }
    for (const ev of await turn(req)) yield ev;
  }
}

const call = (id: string, name: string, args: unknown): ModelEvent => ({ type: 'done', stopReason: 'tool_use', text: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
const finish = (text: string): ModelEvent[] => [{ type: 'text', delta: text }, { type: 'done', stopReason: 'end', text, toolCalls: [] }];
const lastResult = (req: CanonicalModelRequest) => {
  const r = [...req.items].reverse().find((i) => i.kind === 'tool_result') as { content: string; isError?: boolean } | undefined;
  return r ? { ...r, parsed: JSON.parse(r.content) as Record<string, unknown> } : undefined;
};

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

async function setup(start: ProjectState, turns: Turn[], caps: Partial<ReturnType<AgentModelAdapter['capabilities']>> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'so-theme-update-'));
  dirs.push(dir);
  const session = await ProjectSession.create(dir, start);
  const adapter = new FakeAdapter(turns, caps);
  const events: AiEvent[] = [];
  let busy = false;
  const orch = new Orchestrator({
    session: () => session,
    adapter: async () => ({ adapter, model: 'fake', provider: 'openai' }),
    emit: (e) => events.push(e),
    compileAll: async () => [],
    inspectLayout: async () => ({ issues: [] }),
    onBusyChange: (b) => (busy = b)
  });
  const ctx: ChatContext = { pageId: session.state.site.homePageId, pageTitle: 'Home', selection: null, selectionLabel: null, viewport: 1280 };
  const run = async (text: string, extra: Partial<ChatContext> = {}) => {
    const r = await orch.send(text, { ...ctx, ...extra });
    expect(r.ok).toBe(true);
    while (orch.busy || busy) await new Promise((res) => setTimeout(res, 10));
    const msg = [...events].reverse().find((e) => e.kind === 'message' && e.message?.result)?.message;
    return { runId: r.runId!, result: msg?.result };
  };
  return { session, adapter, run };
}

describe('asking for an outlined header button on a header that predates it', () => {
  it('updates the header, sets its Action style, reports both, and undoes both together', async () => {
    let session!: ProjectSession;
    const seen: string[] = [];
    const s = await setup(beforeActionStyle({ hero: true }), [
      (req) => {
        // The request itself says the header has a newer version with an Outlined button, and the tool to take it.
        const first = req.items.find((i) => i.kind === 'user') as { text: string };
        seen.push(first.text);
        const offered = req.tools.find((t) => t.name === 'update_theme_component');
        expect(offered).toBeTruthy();
        return [call('u1', 'update_theme_component', { definitionId: HEADER })];
      },
      (req) => {
        const r = lastResult(req)!;
        expect(r.isError).toBeFalsy();
        expect((r.parsed.component as { properties: Record<string, unknown> }).properties.ctaStyle).toBeTruthy();
        return [call('a1', 'apply_operations', { expectedRevision: session.revision, operations: [{ type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: headerNode(session.state).id, prop: 'ctaStyle', value: 'secondary' }] })];
      },
      (req) => {
        expect(lastResult(req)?.isError).toBeFalsy();
        return finish('Updated the header to the newer theme version and made its Book a call button outlined.');
      }
    ]);
    session = s.session;
    const before = { header: structuredClone(session.state.components[HEADER]), lock: structuredClone(session.state.themeLock.components[HEADER]), props: structuredClone(headerNode(session.state).props) };
    const { runId, result } = await s.run("Make the header's Book a call button outlined");
    expect(seen[0]).toContain('"themeUpdates"');
    expect(seen[0]).toContain('Outlined button');
    expect(result?.status).toBe('completed');
    // The header is the theme's current one, its button outlined, its label and link kept, and nothing else updated.
    expect(definitionHash(session.state.components[HEADER])).toBe(definitionHash(current(HEADER)));
    expect(headerNode(session.state).props).toMatchObject({ ctaStyle: 'secondary', ctaLabel: 'Book a call', ctaLink: before.props.ctaLink, links: before.props.links });
    expect(themeUpdates(session.state).available.map((u) => u.id)).toContain(HERO);
    expect(session.state.themeLock.components[HEADER]).toEqual({ componentId: 'shell.header', version: getTheme('foundation').version, hash: definitionHash(current(HEADER)) });
    const labels = result!.changes.map((c) => c.label);
    expect(labels).toContain("Updated the “Header” component to the theme's newer version");
    expect(labels.some((l) => /action style/i.test(l)), labels.join(" | ")).toBe(true);
    // One undo takes back the edit and the update alike.
    expect((await session.undoGroup(runId)).ok).toBe(true);
    expect(session.state.components[HEADER]).toEqual(before.header);
    expect(session.state.themeLock.components[HEADER]).toEqual(before.lock);
    expect(headerNode(session.state).props).toEqual(before.props);
  });

  it('refuses a component the update tool does not offer this run, even when the model sends it', async () => {
    // Read in the turns, checked after the run: a failed check inside a turn would only end the run.
    let offered: string[] | null = null;
    let answer: ReturnType<typeof lastResult>;
    const s = await setup(
      beforeActionStyle({ hero: true }),
      [
        (req) => {
          offered = enumOf(req.tools.find((t) => t.name === 'update_theme_component'));
          return [call('u1', 'update_theme_component', { definitionId: HEADER })];
        },
        (req) => {
          answer = lastResult(req);
          return finish('Select the header to have its newer version with an outlined button.');
        }
      ],
      { contextWindowTokens: 32000 }
    );
    const before = JSON.stringify(s.session.state.components[HEADER]);
    const { result } = await s.run("Make the header's Book a call button outlined");
    // A small whole-site run's page tool cannot set the header's Action style, so it is not offered the header.
    expect(offered).toEqual([HERO]);
    expect(answer!.isError).toBe(true);
    expect(answer!.parsed).toMatchObject({ error: 'SCOPE_MISMATCH', message: expect.stringMatching(/cannot update/) });
    expect(result?.status).not.toBe('failed');
    expect(JSON.stringify(s.session.state.components[HEADER])).toBe(before);
    expect(result?.changes ?? []).toEqual([]);
  });

  it('explains a held update instead of saying the header cannot do it', async () => {
    let session!: ProjectSession;
    let tools: string[] = [];
    let note: { status?: string; heldBecause?: string } | undefined;
    const s = await setup(beforeActionStyle({ held: true }), [
      (req) => {
        tools = req.tools.map((t) => t.name);
        return [call('r1', 'inspect_element', { owner: { kind: 'shell', id: 'header' }, nodeId: headerNode(session.state).id })];
      },
      (req) => {
        note = lastResult(req)?.parsed.themeUpdate as typeof note;
        return finish("The theme's newer header has an Outlined button style, but this project's header was changed outside the theme, so it cannot be updated here.");
      }
    ]);
    session = s.session;
    const before = JSON.stringify(session.state.components[HEADER]);
    const { result } = await s.run("Make the header's Book a call button outlined");
    expect(tools).not.toContain('update_theme_component');
    expect(note?.status).toBe('held');
    expect(note?.heldBecause).toMatch(/changed outside the theme/);
    expect(result?.status).not.toBe('failed');
    expect(result?.changes ?? []).toEqual([]);
    expect(JSON.stringify(session.state.components[HEADER])).toBe(before);
  });
});

describe('a notice for every page on a header that predates it', () => {
  /** A header installed before it had a notice: still the theme's own (the lock agrees) unless `held`. */
  const beforeNotice = (held: boolean) => {
    const s = structuredClone(createStarterState('business', 'Test', false));
    const header = s.components[HEADER];
    for (const key of ['notice', 'noticeLabel', 'noticeLink']) {
      delete (header.properties as Record<string, unknown>)[key];
      delete headerNode(s).props[key];
    }
    if (!held) s.themeLock.components[HEADER].hash = definitionHash(header);
    return s;
  };

  it('is added by updating the header, never by sending the user to update every component', async () => {
    const { adapter, run } = await setup(beforeNotice(false), [() => finish('Done.')]);
    await run('Tell visitors on every page that the studio is closed on Friday');
    const system = adapter.requests[0].system;
    expect(system).toContain(`update the header with update_theme_component (definitionId "${HEADER}")`);
    expect(system).not.toContain('status bar');
  });

  it('asks for a wider change first in a run that may not change the header', async () => {
    const { adapter, run } = await setup(beforeNotice(false), [() => finish('Done.')]);
    await run('Tell visitors on every page that the studio is closed on Friday', { scope: 'page' });
    const system = adapter.requests[0].system;
    expect(system).toContain('ask them to allow a wider change: updating the header changes every page that shows it');
    expect(system).not.toContain('update the header with update_theme_component (definitionId');
  });

  it('is explained when the header cannot take the update', async () => {
    const { adapter, run } = await setup(beforeNotice(true), [() => finish('Done.')]);
    await run('Tell visitors on every page that the studio is closed on Friday');
    const system = adapter.requests[0].system;
    expect(system).toContain("This project's header has no notice field. The theme's newer header has one, but this project cannot take it: Its stored definition was changed outside the theme.");
    expect(system).not.toContain('update_theme_component (definitionId');
  });
});
