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
    const adds = themeUpdateChanges(was, next);
    expect(adds.options).toEqual({ [prop]: { extra: 'Extra choice' } });
    expect(adds.parts).toEqual({ badge: 'Badge' });
    expect(adds.slots).toEqual({ aside: 'Aside' });
    expect(adds.variants).toEqual({ density: { roomy: 'Roomy', tight: 'Tight' } });
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
    expect((inspected.content as { themeUpdate?: { status: string } }).themeUpdate?.status).toBe('available');
    for (const ref of [
      { owner: { kind: 'shell', id: 'header' }, nodeId: headerNode(s).id, instancePath: [] },
      { owner: { kind: 'shell', id: 'header' }, nodeId: 'root', instancePath: [headerNode(s).id], partId: 'root' }
    ] as ElementRef[])
      expect((describeSelection(s, ref) as { themeUpdate?: { status: string } }).themeUpdate?.status).toBe('available');
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
    const summary = projectSummary(s, 1) as { themeUpdates?: { held?: Array<{ definitionId: string; reason: string; adds: string[] }> } };
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
    expect(out.content).toMatchObject({ error: 'UPDATE_HELD', message: expect.stringMatching(/changed outside the theme/), newVersionAdds: { properties: { ctaStyle: expect.anything() } } });
    expect(applied).toEqual([]);
  });

  it('refuses a component with no newer version, and a raw or bulk theme.refresh', async () => {
    const s = createStarterState('business', 'Test', false);
    const { h, applied } = host(s);
    expect((await tool(h, 'update_theme_component', { definitionId: HEADER })).content).toMatchObject({ message: expect.stringMatching(/no newer theme version/) });
    const raw = await tool(h, 'apply_operations', { expectedRevision: 1, operations: [{ type: 'theme.refresh' }] });
    expect(raw.content).toMatchObject({ error: 'INVALID_ARGUMENT', message: expect.stringMatching(/update_theme_component/) });
    expect(applied).toEqual([]);
  });

  it('is offered with the components a run can update, to small models and large, in edit runs only', () => {
    const s = beforeActionStyle({ hero: true });
    const big = { toolCalling: 'native' as const, contextWindowTokens: 200000 };
    const small = { toolCalling: 'constrained-json' as const, contextWindowTokens: 8000 };
    const selection = { owner: { kind: 'shell' as const, id: 'header' }, nodeId: headerNode(s).id };
    const page = { route: '/' };
    for (const capabilities of [big, small])
      for (const extra of [{ selection: null }, { selection }, { selection: null, page }]) {
        const run = toolsForRun({ state: s, capabilities, codeEnabled: false, definitionOps: false, ...extra });
        const t = run.tools.find((x) => x.name === 'update_theme_component');
        expect(t, `${run.mode} ${capabilities.toolCalling}`).toBeTruthy();
        expect((t!.parameters as { properties: { definitionId: { enum: string[] } } }).properties.definitionId.enum).toEqual(expect.arrayContaining([HEADER, HERO]));
      }
    expect(names(toolsForRun({ state: s, selection: null, capabilities: big, codeEnabled: false, definitionOps: false, ask: true }).tools)).not.toContain('update_theme_component');
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
  });
});

describe('scope of an update', () => {
  const refresh = (id: string): EditOperation[] => [{ type: 'theme.refresh', definitionIds: [id] }];

  it('lets a selected header update itself, but never through a raw, bulk or other component’s update', () => {
    const s = beforeActionStyle({ hero: true });
    const sel: Authority = { kind: 'selection', owner: { kind: 'shell', id: 'header' }, nodeId: headerNode(s).id, label: 'the header' };
    expect(checkAuthority(s, refresh(HEADER), sel, { themeRefresh: HEADER })).toBeNull();
    expect(checkAuthority(s, refresh(HEADER), sel)).toMatch(/more than the header/);
    expect(checkAuthority(s, [{ type: 'theme.refresh' }], sel, { themeRefresh: HEADER })).toMatch(/more than the header/);
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
  });
});

describe('the turn report', () => {
  it('names the components an update changed', () => {
    const s = beforeActionStyle({ hero: true });
    const ops: EditOperation[] = [{ type: 'theme.refresh', definitionIds: [HEADER] }];
    const { state, results } = applyOperations(s, ops);
    expect(describeOps(ops, s, state, results).map((c) => c.label)).toEqual(["Updated the “Header” component to the theme's newer version"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The whole request, through a scripted model (#692's acceptance)
// ---------------------------------------------------------------------------------------------------------------

type Turn = (req: CanonicalModelRequest) => ModelEvent[] | Promise<ModelEvent[]>;

class FakeAdapter implements AgentModelAdapter {
  requests: CanonicalModelRequest[] = [];
  constructor(private turns: Turn[]) {}
  capabilities() {
    return { toolCalling: 'native' as const, streaming: true, strictSchemas: false, parallelToolCalls: true, contextWindowTokens: 100000, maxOutputTokens: 32000 } as ReturnType<AgentModelAdapter['capabilities']>;
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

async function setup(start: ProjectState, turns: Turn[]) {
  const dir = mkdtempSync(join(tmpdir(), 'so-theme-update-'));
  dirs.push(dir);
  const session = await ProjectSession.create(dir, start);
  const adapter = new FakeAdapter(turns);
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
    const labels = result!.changes.map((c) => c.label);
    expect(labels).toContain("Updated the “Header” component to the theme's newer version");
    expect(labels.some((l) => /action style/i.test(l)), labels.join(" | ")).toBe(true);
    // One undo takes back the edit and the update alike.
    expect((await session.undoGroup(runId)).ok).toBe(true);
    expect(session.state.components[HEADER]).toEqual(before.header);
    expect(session.state.themeLock.components[HEADER]).toEqual(before.lock);
    expect(headerNode(session.state).props).toEqual(before.props);
  });

  it('explains a held update instead of saying the header cannot do it', async () => {
    let session!: ProjectSession;
    const s = await setup(beforeActionStyle({ held: true }), [
      (req) => {
        expect(req.tools.map((t) => t.name)).not.toContain('update_theme_component');
        return [call('r1', 'inspect_element', { owner: { kind: 'shell', id: 'header' }, nodeId: headerNode(session.state).id })];
      },
      (req) => {
        const note = lastResult(req)!.parsed.themeUpdate as { status: string; heldBecause: string };
        expect(note.status).toBe('held');
        expect(note.heldBecause).toMatch(/changed outside the theme/);
        return finish("The theme's newer header has an Outlined button style, but this project's header was changed outside the theme, so it cannot be updated here.");
      }
    ]);
    session = s.session;
    const before = JSON.stringify(session.state.components[HEADER]);
    const { result } = await s.run("Make the header's Book a call button outlined");
    expect(result?.changes ?? []).toEqual([]);
    expect(JSON.stringify(session.state.components[HEADER])).toBe(before);
  });
});
