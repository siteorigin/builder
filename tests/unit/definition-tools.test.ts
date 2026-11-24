/**
 * The definition tools (#360): a small model editing a component everywhere, or a node selected in it, gets tools built
 * from that design instead of the general operations, and every call still goes through the run's authority.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElementRef, InstanceNode, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { executeTool, toolsForRun, type ToolHost } from '@agent/tools';
import { definitionTarget, definitionTools, type DefinitionTarget } from '@agent/definition';
import { authorityFor, checkAuthority, type Authority } from '@agent/scope';
import { findForbiddenShapes, OPEN_VALUE_KEY, toStrictSchema } from '@agent/strict-schema';
import { hasOpenSchema } from '@agent/propschema';
import type { ToolDefinition } from '@agent/types';
import { ProjectSession } from '../../src/main/project/session';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

const local = { toolCalling: 'constrained-json' as const, contextWindowTokens: 32_000 };
const names = (t: ToolDefinition[]) => t.map((x) => x.name);
const tool = (t: ToolDefinition[], name: string) => t.find((x) => x.name === name)!;
type Schema = { enum?: string[]; anyOf?: Schema[]; properties?: Record<string, Schema>; type?: string | string[] };
const prop = (t: ToolDefinition, ...path: string[]): Schema => path.reduce<Schema>((s, k) => s.properties![k], t.parameters as Schema);
const MICRO = ['edit_definition_node', 'bind_definition_field', 'manage_component_prop', 'style_definition_element', 'add_definition_variant'];

/** A project with the Split hero copied for editing everywhere, as the editor makes one. */
async function hero() {
  const dir = mkdtempSync(join(tmpdir(), 'so-def-'));
  dirs.push(dir);
  const session = await ProjectSession.create(dir, createStarterState('business', 'Test', false));
  const home = session.state.pages[session.state.site.homePageId];
  const r = await session.apply({ operations: [{ type: 'component.fork', definitionId: (home.nodes[home.rootIds[0]] as InstanceNode).definitionId }] }, { label: 'Edit everywhere', source: 'user' });
  const id = (r.results?.[0] as { definitionId: string }).definitionId;
  return { session, id, owner: { kind: 'component' as const, id } };
}

/** What the orchestrator sends: the editor's selection and component, turned into the run's authority. */
function authorityOf(state: ProjectState, id: string, selection: ElementRef | null): Authority {
  return authorityFor(selection, selection ? 'Selected' : null, { id, name: 'Split hero' }, state);
}

/** A host like the orchestrator's: the run's authority decides, then the session applies. */
function hostFor(session: ProjectSession, authority: Authority): ToolHost {
  const target = definitionTarget(authority);
  return {
    state: () => session.state,
    revision: () => session.revision,
    diagnostics: () => [],
    compileAll: async () => [],
    inspectLayout: async () => null,
    ask: async () => '',
    definitionTarget: () => target,
    apply: async (operations: EditOperation[], expectedRevision: number, label: string) => {
      const denied = checkAuthority(session.state, operations, authority);
      if (denied) return { ok: false, revision: session.revision, error: { code: 'SCOPE_MISMATCH', message: denied } };
      return session.apply({ operations, expectedRevision }, { label, source: 'ai' });
    }
  };
}

const run = (host: ToolHost, name: string, args: unknown) => executeTool(name, JSON.stringify(args), host, `c_${Math.random()}`);
const errorOf = (o: { content: unknown }) => o.content as { error?: string | { code?: string; message?: string }; message?: string };

describe('choosing the definition tools', () => {
  it('keeps a small model focused on a component edited everywhere, or a node selected in it', async () => {
    const { session, id, owner } = await hero();
    const state = session.state;
    const base = { state, codeEnabled: false, definitionOps: true, definition: true };
    const whole = definitionTarget(authorityOf(state, id, null));
    const inner = definitionTarget(authorityOf(state, id, { owner, instancePath: [], nodeId: 'content' }));
    for (const capabilities of [local, { toolCalling: 'native' as const, contextWindowTokens: 63_999 }, { toolCalling: 'constrained-json' as const, contextWindowTokens: 500_000 }]) {
      for (const target of [whole, inner]) {
        const r = toolsForRun({ ...base, selection: target === inner ? { owner, nodeId: 'content' } : null, capabilities, definitionTarget: target });
        expect(r).toMatchObject({ mode: 'definition', focused: true });
        expect(names(r.tools)).toEqual(expect.arrayContaining([...MICRO, 'read_component', 'request_clarification']));
        expect(names(r.tools)).not.toContain('apply_operations');
        for (const t of r.tools) {
          expect(findForbiddenShapes(toStrictSchema(t.parameters)), t.name).toEqual([]);
          expect(JSON.stringify(toStrictSchema(t.parameters)), t.name).not.toContain(OPEN_VALUE_KEY);
        }
        // The definition tools are closed as written, with no open object anywhere.
        for (const t of r.tools.filter((x) => MICRO.includes(x.name))) {
          expect(findForbiddenShapes(t.parameters), t.name).toEqual([]);
          expect(hasOpenSchema(t.parameters), t.name).toBe(false);
        }
      }
    }
    // A model with room to spare keeps the general tools, and so does a small one the author let change more.
    expect(toolsForRun({ ...base, selection: null, capabilities: { toolCalling: 'native', contextWindowTokens: 64_000 }, definitionTarget: whole })).toMatchObject({ mode: 'general', focused: false });
    const widened = toolsForRun({ ...base, selection: null, capabilities: local, definitionTarget: null });
    expect(widened).toMatchObject({ mode: 'general', focused: false });
    expect(names(widened.tools)).toContain('apply_operations');
    // The grammar a constrained model is held to is a small fraction of the general one it replaces.
    const wire = (t: ToolDefinition[]) => t.reduce((n, x) => n + JSON.stringify(toStrictSchema(x.parameters)).length, 0);
    const focused = toolsForRun({ ...base, selection: null, capabilities: local, definitionTarget: whole });
    expect(wire(focused.tools) * 3).toBeLessThan(wire(widened.tools));
  });

  it("builds each schema from the design's own nodes, properties, parts and variant axes", async () => {
    const { session, id, owner } = await hero();
    const state = session.state;
    const def = state.components[id];
    const whole = definitionTools(state, { definitionId: id })!;
    expect(prop(tool(whole, 'bind_definition_field'), 'binding').anyOf![0].properties!.$prop.enum).toEqual(Object.keys(def.properties));
    expect(prop(tool(whole, 'style_definition_element'), 'partId').enum).toEqual(Object.keys(def.parts));
    const variants = prop(tool(whole, 'style_definition_element'), 'variant').anyOf!;
    expect(variants.map((v) => [v.properties!.axis.enum, v.properties!.option.enum])).toEqual([
      [['tone'], ['default', 'muted', 'inverse']],
      [['layout'], ['default', 'media-start']]
    ]);
    // The whole component may change or remove its properties; a new axis may be added.
    expect(prop(tool(whole, 'manage_component_prop'), 'change').anyOf!.map((b) => b.properties!.action.enum![0])).toEqual(['add', 'set_default', 'remove']);
    expect(prop(tool(whole, 'add_definition_variant'), 'axis').enum).toBeUndefined();
    // A node selected in the design offers only it and what is inside it, and only additions to the contract.
    const inner = definitionTools(state, { definitionId: id, nodeId: 'content' })!;
    expect(prop(tool(inner, 'bind_definition_field'), 'nodeId').enum).toEqual(['content', 'eyebrow', 'heading', 'lead', 'actions', 'primary', 'secondary']);
    expect(prop(tool(inner, 'edit_definition_node'), 'nodeId').enum).not.toContain('media');
    expect(prop(tool(inner, 'style_definition_element'), 'partId').enum).toEqual(['eyebrow', 'heading', 'lead', 'actions']);
    expect(prop(tool(inner, 'manage_component_prop'), 'change').properties!.action.enum).toEqual(['add']);
    expect(prop(tool(inner, 'add_definition_variant'), 'axis').enum).toEqual(['tone', 'layout']);
    // Only nodes that are not parts yet can be exposed, and the content fields are those of the nodes here.
    expect(Object.keys(prop(tool(inner, 'edit_definition_node'), 'content').properties!)).toEqual(['text', 'tag', 'label', 'link', 'appearance']);
    expect(Object.keys(prop(tool(inner, 'edit_definition_node'), 'exposeAsPart').properties!)).toEqual(['partId', 'label']);
    // A design that changed is offered as it is now: a property added in one step can be bound in the next.
    const host = hostFor(session, authorityOf(state, id, null));
    expect((await run(host, 'manage_component_prop', { change: { action: 'add', prop: 'badge', label: 'Badge', type: 'string', default: 'New' } })).ok).toBe(true);
    expect(prop(tool(definitionTools(session.state, { definitionId: id })!, 'bind_definition_field'), 'binding').anyOf![0].properties!.$prop.enum).toContain('badge');
    expect(definitionTools(session.state, { definitionId: id, nodeId: 'gone' })).toBeNull();
    expect(definitionTools(session.state, { definitionId: 'proj.gone' })).toBeNull();
    void owner;
  });

  it('offers a part picked inside a placement in the design its own styles alone', async () => {
    const { session, id, owner } = await hero();
    const inserted = await session.apply({ operations: [{ type: 'node.insert', owner, parentId: 'content', componentId: 'content.text' }] }, { label: 'Insert', source: 'user' });
    expect(inserted.ok).toBe(true);
    const nested = (inserted.results?.[0] as { nodeId: string }).nodeId;
    const nestedDef = session.state.components[(session.state.components[id].tree!.nodes[nested] as InstanceNode).definitionId];
    const partId = Object.keys(nestedDef.parts).find((p) => p !== 'root' && nestedDef.parts[p].nodeId !== nestedDef.tree!.rootIds[0])!;
    const pick: ElementRef = { owner, instancePath: [nested], nodeId: nestedDef.parts[partId].nodeId, partId };
    const authority = authorityOf(session.state, id, pick);
    expect(authority).toMatchObject({ kind: 'selection', part: { partId } });
    const r = toolsForRun({ state: session.state, selection: null, capabilities: local, codeEnabled: false, definitionOps: true, definition: true, definitionTarget: definitionTarget(authority) });
    expect(r.mode).toBe('definition');
    expect(names(r.tools)).toEqual(['style_definition_element', 'read_component', 'request_clarification']);
    expect(prop(tool(r.tools, 'style_definition_element'), 'partId').enum).toEqual([partId]);
    const host = hostFor(session, authority);
    const styled = await run(host, 'style_definition_element', { scope: 'base', styles: [{ property: 'color', value: { token: 'color.brand' } }] });
    expect(styled.ok).toBe(true);
    expect(styled.ops).toEqual([{ type: 'node.setStyle', owner, nodeId: nested, partId, scope: 'base', property: 'color', value: { token: 'color.brand' } }]);
    // Nothing else of the design, nor of the placement.
    expect(errorOf(await run(host, 'manage_component_prop', { change: { action: 'add', prop: 'extra', label: 'Extra', type: 'string' } })).message).toMatch(/only the selected part/);
    expect(errorOf(await run(host, 'style_definition_element', { partId: 'root', scope: 'base', styles: [{ property: 'color', value: null }] })).message).toMatch(/only the selected part/);
    // Deeper inside the placement: nothing to change without the author's approval.
    const deeper = authorityOf(session.state, id, { ...pick, instancePath: [nested, 'n_x'] });
    expect(names(toolsForRun({ state: session.state, selection: null, capabilities: local, codeEnabled: false, definitionOps: true, definition: true, definitionTarget: definitionTarget(deeper) }).tools)).toEqual(['read_component', 'request_clarification']);
  });
});

describe('running the definition tools', () => {
  it('adds a property, binds a heading and a condition to it, exposes a part and styles a variant option', async () => {
    const { session, id, owner } = await hero();
    const host = hostFor(session, authorityOf(session.state, id, null));
    const before = structuredClone(session.state.components[id].tree!.nodes.content);
    expect((await run(host, 'manage_component_prop', { change: { action: 'add', prop: 'showButtons', label: 'Show buttons', type: 'boolean', default: true } })).ok).toBe(true);
    expect((await run(host, 'manage_component_prop', { change: { action: 'add', prop: 'title', label: 'Title', type: 'string', default: 'Hello' } })).ok).toBe(true);
    expect((await run(host, 'bind_definition_field', { nodeId: 'actions', field: 'when', binding: { $prop: 'showButtons' } })).ok).toBe(true);
    expect((await run(host, 'bind_definition_field', { nodeId: 'heading', field: 'text', binding: { $prop: 'title' } })).ok).toBe(true);
    expect((await run(host, 'edit_definition_node', { nodeId: 'content', exposeAsPart: { partId: 'copy', label: 'Copy' } })).ok).toBe(true);
    const styled = await run(host, 'style_definition_element', { partId: 'copy', variant: { axis: 'tone', option: 'muted' }, scope: 'phone', styles: [{ property: 'gap', value: { token: 'space.lg' } }] });
    expect(styled.ok).toBe(true);
    expect(styled.ops).toEqual([{ type: 'node.setStyle', owner, nodeId: 'content', variant: 'muted', axis: 'tone', scope: 'phone', property: 'gap', value: { token: 'space.lg' } }]);
    const def = session.state.components[id];
    expect(def.properties.showButtons).toMatchObject({ type: 'boolean', label: 'Show buttons', default: true });
    expect(def.tree!.nodes.actions.when).toEqual({ $prop: 'showButtons' });
    expect((def.tree!.nodes.heading as { text?: unknown }).text).toEqual({ $prop: 'title' });
    expect(def.parts.copy).toMatchObject({ nodeId: 'content', label: 'Copy' });
    expect(JSON.stringify(def.variantAxes!.tone.options.muted.styles)).toContain('space.lg');
    // The base style every placement starts from is untouched.
    expect(def.tree!.nodes.content.styles).toEqual(before.styles);
    // A new option, then its content edit and a default for the whole component.
    expect((await run(host, 'add_definition_variant', { axis: 'tone', option: 'bold', label: 'Bold' })).ok).toBe(true);
    expect(Object.keys(session.state.components[id].variantAxes!.tone.options)).toContain('bold');
    expect((await run(host, 'manage_component_prop', { change: { action: 'set_default', prop: 'title', value: 'Welcome' } })).ok).toBe(true);
    expect(session.state.components[id].properties.title.default).toBe('Welcome');
    expect((await run(host, 'edit_definition_node', { nodeId: 'lead', content: { tag: 'h3' } })).ok).toBe(true);
  });

  it('reports what a call gets wrong, by field, and applies nothing', async () => {
    const { session, id } = await hero();
    const host = hostFor(session, authorityOf(session.state, id, null));
    const revision = session.revision;
    const bad: Array<[string, unknown, RegExp]> = [
      ['manage_component_prop', { change: { action: 'add', prop: 'heading', label: 'Heading', type: 'string' } }, /already has a property "heading"/],
      ['manage_component_prop', { change: { action: 'add', prop: 'size', label: 'Size', type: 'string', options: ['a'] } }, /only an enum property has options/],
      ['manage_component_prop', { change: { action: 'add', prop: 'photo', label: 'Photo', type: 'image', default: 'x' } }, /starts empty/],
      ['manage_component_prop', { change: { action: 'remove', prop: 'nope' } }, /has no property "nope"/],
      ['edit_definition_node', { nodeId: 'content', content: { text: 'Hi' } }, /no content of its own/],
      ['edit_definition_node', { nodeId: 'heading', exposeAsPart: { partId: 'title', label: 'Title' } }, /already the "heading" part/],
      ['edit_definition_node', { nodeId: 'grid' }, /send the content to change/],
      ['bind_definition_field', { nodeId: 'media', field: 'text', binding: { $prop: 'heading' } }, /binds when, unless, image/],
      ['style_definition_element', { nodeId: 'nope', scope: 'base', styles: [{ property: 'gap', value: null }] }, /no node "nope"/],
      ['style_definition_element', { scope: 'base', variant: { axis: 'tone', option: 'loud' }, styles: [{ property: 'gap', value: null }] }, /must be one of: default, muted, inverse/],
      ['style_definition_element', { scope: 'base', state: 'hover', styles: [{ property: 'gap', value: '1rem' }] }, /styles\[0\]\.property/],
      ['add_definition_variant', { axis: 'tone', option: 'muted', label: 'Muted' }, /already an option of tone/]
    ];
    for (const [name, args, message] of bad) {
      const r = await run(host, name, args);
      expect(r.ok, name).toBe(false);
      expect(errorOf(r).message, name).toMatch(message);
    }
    expect(session.revision).toBe(revision);
  });

  it('keeps a node selected in the design to it and what is inside it', async () => {
    const { session, id, owner } = await hero();
    const authority = authorityOf(session.state, id, { owner, instancePath: [], nodeId: 'content' });
    const host = hostFor(session, authority);
    // Additions inside the selection: a property, a binding, a part and a rule for an option it already has.
    expect((await run(host, 'manage_component_prop', { change: { action: 'add', prop: 'showLead', label: 'Show lead', type: 'boolean' } })).ok).toBe(true);
    expect((await run(host, 'bind_definition_field', { nodeId: 'lead', field: 'when', binding: { $prop: 'showLead' }, eq: true })).ok).toBe(true);
    expect((await run(host, 'edit_definition_node', { nodeId: 'content', exposeAsPart: { partId: 'copy', label: 'Copy' } })).ok).toBe(true);
    expect((await run(host, 'style_definition_element', { variant: { axis: 'layout', option: 'media-start' }, scope: 'base', styles: [{ property: 'gap', value: { token: 'space.lg' } }] })).ok).toBe(true);
    expect(session.state.components[id].tree!.nodes.lead.when).toEqual({ ref: { $prop: 'showLead' }, eq: true });
    const revision = session.revision;
    // Outside it: a node beside it, a default every placement shows, an existing property, a new axis.
    expect(errorOf(await run(host, 'style_definition_element', { nodeId: 'media', scope: 'base', styles: [{ property: 'gap', value: null }] })).message).toMatch(/"media" is outside what this request may change/);
    const scoped: Array<[string, unknown]> = [
      ['edit_definition_node', { nodeId: 'heading', content: { text: 'Hello' } }],
      ['manage_component_prop', { change: { action: 'set_default', prop: 'heading', value: 'Hello' } }],
      ['manage_component_prop', { change: { action: 'remove', prop: 'lead' } }],
      ['add_definition_variant', { axis: 'size', option: 'large', label: 'Large' }]
    ];
    for (const [name, args] of scoped) {
      const r = await run(host, name, args);
      expect(r.ok, name).toBe(false);
      expect((errorOf(r).error as { code?: string }).code, name).toBe('SCOPE_MISMATCH');
    }
    expect(session.revision).toBe(revision);
  });

  it('refuses a call once the design it addresses is gone', async () => {
    const { session, id } = await hero();
    const host = { ...hostFor(session, authorityOf(session.state, id, null)), definitionTarget: (): DefinitionTarget => ({ definitionId: 'proj.gone' }) };
    expect(errorOf(await run(host, 'manage_component_prop', { change: { action: 'add', prop: 'x', label: 'X', type: 'string' } })).message).toMatch(/no longer in the site/);
    expect(errorOf(await run({ ...host, definitionTarget: undefined }, 'manage_component_prop', { change: { action: 'add', prop: 'x', label: 'X', type: 'string' } })).message).toMatch(/no longer in the site/);
  });
});
