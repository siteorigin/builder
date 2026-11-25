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
const MICRO = ['edit_definition_node', 'bind_definition_field', 'manage_component_prop', 'manage_component_state', 'style_definition_element', 'add_definition_variant', 'insert_definition_node', 'remove_definition_node'];

/** A project with the Split hero copied for editing everywhere, as the editor makes one. */
async function hero(prepare?: (s: ProjectState) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'so-def-'));
  dirs.push(dir);
  const initial = createStarterState('business', 'Test', false);
  prepare?.(initial);
  const session = await ProjectSession.create(dir, initial);
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
    // The read is of this design alone.
    expect(prop(tool(toolsForRun({ ...base, selection: null, capabilities: local, definitionTarget: whole }).tools, 'read_component'), 'definitionId').enum).toEqual([id]);
    // A model whose window cannot hold the general tools beside the request is narrowed to them too.
    expect(toolsForRun({ ...base, selection: null, capabilities: { toolCalling: 'native', contextWindowTokens: 400_000 }, focused: true, definitionTarget: whole })).toMatchObject({ mode: 'definition', focused: true });
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
    // A selected node that is already a part offers its content but nothing to expose (its level is a property's,
    // so not its tag), and cannot remove the root.
    const leaf = definitionTools(state, { definitionId: id, nodeId: 'heading' })!;
    expect(Object.keys(prop(tool(leaf, 'edit_definition_node'), 'content').properties!)).toEqual(['text']);
    expect(tool(leaf, 'edit_definition_node').parameters).not.toHaveProperty('properties.exposeAsPart');
    expect(names(leaf)).not.toContain('insert_definition_node');
    expect(prop(tool(whole, 'remove_definition_node'), 'nodeId').enum).not.toContain(def.tree!.rootIds[0]);
    expect(prop(tool(whole, 'insert_definition_node'), 'parentId').enum).toEqual(expect.arrayContaining(['root', 'content', 'actions']));
    expect(prop(tool(whole, 'insert_definition_node'), 'parentId').enum).not.toContain('heading');
    // A design that changed is offered as it is now: a property added in one step can be bound in the next.
    const host = hostFor(session, authorityOf(state, id, null));
    expect((await run(host, 'manage_component_prop', { change: { action: 'add', prop: 'badge', label: 'Badge', type: 'string', default: 'New' } })).ok).toBe(true);
    expect(prop(tool(definitionTools(session.state, { definitionId: id })!, 'bind_definition_field'), 'binding').anyOf![0].properties!.$prop.enum).toContain('badge');
    expect(definitionTools(session.state, { definitionId: id, nodeId: 'gone' })).toBeNull();
    expect(definitionTools(session.state, { definitionId: 'proj.gone' })).toBeNull();
    // A run whose selected node is gone (it removed it, say) may change nothing more: it keeps the small reads.
    const gone = toolsForRun({ state: session.state, selection: null, capabilities: local, codeEnabled: false, definitionOps: true, definition: true, definitionTarget: { definitionId: id, nodeId: 'gone' } });
    expect(gone).toMatchObject({ mode: 'definition', focused: true });
    expect(names(gone.tools)).toEqual(['read_component', 'search_assets', 'request_clarification']);
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
    expect(names(r.tools)).toEqual(['style_definition_element', 'read_component', 'search_assets', 'request_clarification']);
    expect(prop(tool(r.tools, 'style_definition_element'), 'partId').enum).toEqual([partId]);
    const host = hostFor(session, authority);
    const styled = await run(host, 'style_definition_element', { scope: 'base', styles: [{ property: 'color', value: { token: 'color.brand' } }] });
    expect(styled.ok).toBe(true);
    expect(styled.ops).toEqual([{ type: 'node.setStyle', owner, nodeId: nested, partId, scope: 'base', property: 'color', value: { token: 'color.brand' } }]);
    // Nothing else of the design, nor of the placement.
    expect(errorOf(await run(host, 'manage_component_prop', { change: { action: 'add', prop: 'extra', label: 'Extra', type: 'string' } })).message).toMatch(/only the selected part/);
    expect(errorOf(await run(host, 'style_definition_element', { partId: 'root', scope: 'base', styles: [{ property: 'color', value: null }] })).message).toMatch(/only the selected part/);
    expect(errorOf(await run(host, 'style_definition_element', { nodeId: 'content', scope: 'base', styles: [{ property: 'color', value: null }] })).message).toMatch(/only the selected part/);
    // One item of a part shown per item: a design styles every item alike, so nothing is offered.
    const item = authorityOf(session.state, id, { ...pick, itemPath: ['i_1'] });
    expect(item).toMatchObject({ part: { partId, itemId: 'i_1' } });
    expect(names(toolsForRun({ state: session.state, selection: null, capabilities: local, codeEnabled: false, definitionOps: true, definition: true, definitionTarget: definitionTarget(item) }).tools)).toEqual(['read_component', 'search_assets', 'request_clarification']);
    expect(errorOf(await run(hostFor(session, item), 'style_definition_element', { scope: 'base', styles: [{ property: 'color', value: null }] })).message).toMatch(/one item of it/);
    // Deeper inside the placement: nothing to change without the author's approval.
    const deeper = authorityOf(session.state, id, { ...pick, instancePath: [nested, 'n_x'] });
    expect(names(toolsForRun({ state: session.state, selection: null, capabilities: local, codeEnabled: false, definitionOps: true, definition: true, definitionTarget: definitionTarget(deeper) }).tools)).toEqual(['read_component', 'search_assets', 'request_clarification']);
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
    expect(session.state.components[id].variantAxes!.tone.options.bold).toMatchObject({ label: 'Bold' });
    expect(session.state.components[id].variantAxes!.tone.default).toBe('default');
    expect((await run(host, 'manage_component_prop', { change: { action: 'set_default', prop: 'title', value: 'Welcome' } })).ok).toBe(true);
    expect(session.state.components[id].properties.title.default).toBe('Welcome');
    expect((await run(host, 'edit_definition_node', { nodeId: 'lead', content: { tag: 'h3' } })).ok).toBe(true);
    expect((session.state.components[id].tree!.nodes.lead as { tag?: string }).tag).toBe('h3');
  });

  it('adds an element to a container, which the next step can bind, and removes one', async () => {
    const { session, id } = await hero();
    const host = hostFor(session, authorityOf(session.state, id, null));
    expect((await run(host, 'manage_component_prop', { change: { action: 'add', prop: 'tagline', label: 'Tagline', type: 'string', default: 'Made by hand' } })).ok).toBe(true);
    const added = await run(host, 'insert_definition_node', { parentId: 'content', primitive: 'paragraph', text: 'Made by hand', index: 2 });
    expect(added.ok).toBe(true);
    const nodeId = (added.content as { nodeId: string }).nodeId;
    expect(session.state.components[id].tree!.nodes[nodeId]).toMatchObject({ kind: 'text', text: 'Made by hand' });
    expect(session.state.components[id].tree!.nodes.content).toMatchObject({ children: expect.arrayContaining([nodeId]) });
    expect((session.state.components[id].tree!.nodes.content as { children: string[] }).children.indexOf(nodeId)).toBe(2);
    expect(prop(tool(definitionTools(session.state, { definitionId: id })!, 'bind_definition_field'), 'nodeId').enum).toContain(nodeId);
    expect((await run(host, 'bind_definition_field', { nodeId, field: 'text', binding: { $prop: 'tagline' } })).ok).toBe(true);
    expect((session.state.components[id].tree!.nodes[nodeId] as { text?: unknown }).text).toEqual({ $prop: 'tagline' });
    // Without an index, at the end.
    const last = (await run(host, 'insert_definition_node', { parentId: 'content', primitive: 'divider' })).content as { nodeId: string };
    expect((session.state.components[id].tree!.nodes.content as { children: string[] }).children.at(-1)).toBe(last.nodeId);
    expect((await run(host, 'remove_definition_node', { nodeId: 'secondary' })).ok).toBe(true);
    expect(session.state.components[id].tree!.nodes.secondary).toBeUndefined();
    const revision = session.revision;
    expect(errorOf(await run(host, 'insert_definition_node', { parentId: 'heading', primitive: 'icon' })).message).toMatch(/"heading" holds no children/);
    expect(errorOf(await run(host, 'remove_definition_node', { nodeId: 'root' })).message).toMatch(/"root" is the design's root/);
    expect(session.revision).toBe(revision);
    // A slot's outlet shows what each placement put there: neither it nor what holds it is removed without the author.
    expect((await session.apply({ operations: [{ type: 'component.setSlot', definitionId: id, slot: 'extra', label: 'Extra' }, { type: 'node.insert', owner: { kind: 'component', id }, parentId: 'actions', primitive: 'slot', bind: 'extra' }] }, { label: 'Slot', source: 'user' })).ok).toBe(true);
    const outlet = Object.values(session.state.components[id].tree!.nodes).find((n) => n.kind === 'slot')!.id;
    const removable = prop(tool(definitionTools(session.state, { definitionId: id })!, 'remove_definition_node'), 'nodeId').enum!;
    for (const holder of [outlet, 'actions', 'content']) expect(removable).not.toContain(holder);
    expect(removable).toContain('lead');
    expect(errorOf(await run(host, 'remove_definition_node', { nodeId: 'actions' })).message).toMatch(/holds a slot's outlet/);
  });

  it("keeps an image's picture when only its alt text is sent", async () => {
    const assetId = 'a1';
    const { session, id } = await hero((s) => void (s.assets.assets[assetId] = { id: assetId, name: 'Room', file: 'static/assets/room.jpg', mime: 'image/jpeg', bytes: 1, width: 10, height: 10, hash: 'x', kind: 'image', createdAt: '' }));
    const host = hostFor(session, authorityOf(session.state, id, null));
    const added = await run(host, 'insert_definition_node', { parentId: 'content', primitive: 'image' });
    const nodeId = (added.content as { nodeId: string }).nodeId;
    expect((await run(host, 'edit_definition_node', { nodeId, content: { image: { assetId, alt: 'A room' } } })).ok).toBe(true);
    expect((await run(host, 'edit_definition_node', { nodeId, content: { image: { alt: 'A calm room' } } })).ok).toBe(true);
    expect((session.state.components[id].tree!.nodes[nodeId] as { image?: unknown }).image).toMatchObject({ assetId, alt: 'A calm room' });
    // The grammar asks only for the alt text, so the merge can be reached.
    const content = prop(tool(definitionTools(session.state, { definitionId: id })!, 'edit_definition_node'), 'content') as { properties: Record<string, { required?: string[] }> };
    expect(content.properties.image.required).toEqual(['alt']);
    // An image property starts from a picture by its assetId, and its default can be set the same way.
    expect((await run(host, 'manage_component_prop', { change: { action: 'add', prop: 'photo', label: 'Photo', type: 'image', default: assetId } })).ok).toBe(true);
    expect(session.state.components[id].properties.photo.default).toMatchObject({ assetId });
    expect((await run(host, 'manage_component_prop', { change: { action: 'set_default', prop: 'photo', value: assetId } })).ok).toBe(true);
    // Anything but an ID would read as no picture, so it is refused and the default stays.
    const revision = session.revision;
    expect(errorOf(await run(host, 'manage_component_prop', { change: { action: 'set_default', prop: 'photo', value: false } })).message).toMatch(/default is its assetId/);
    expect(errorOf(await run(host, 'manage_component_prop', { change: { action: 'add', prop: 'banner', label: 'Banner', type: 'image', default: 42 } })).message).toMatch(/default is its assetId/);
    expect(session.revision).toBe(revision);
    expect(session.state.components[id].properties.photo.default).toMatchObject({ assetId });
    // A picture bound to a property is not this node's to keep: its assetId is needed.
    expect(errorOf(await run(host, 'edit_definition_node', { nodeId: 'media', content: { image: { alt: 'x' } } })).message).toMatch(/send its assetId/);
  });

  it('reports what a call gets wrong, by field, and applies nothing', async () => {
    const { session, id } = await hero();
    const host = hostFor(session, authorityOf(session.state, id, null));
    const revision = session.revision;
    const bad: Array<[string, unknown, RegExp]> = [
      ['manage_component_prop', { change: { action: 'add', prop: 'heading', label: 'Heading', type: 'string' } }, /already has a property "heading"/],
      ['manage_component_prop', { change: { action: 'add', prop: 'size', label: 'Size', type: 'string', options: ['a'] } }, /only an enum property has options/],
      ['manage_component_prop', { change: { action: 'add', prop: 'photo', label: 'Photo', type: 'image', default: 'x' } }, /change\.default/],
      ['manage_component_prop', { change: { action: 'add', prop: 'when', label: 'When', type: 'link', default: true } }, /change\.default/],
      ['manage_component_prop', { change: { action: 'remove', prop: 'nope' } }, /has no property "nope"/],
      ['edit_definition_node', { nodeId: 'content', content: { text: 'Hi' } }, /no content of its own/],
      ['edit_definition_node', { nodeId: 'heading', exposeAsPart: { partId: 'title', label: 'Title' } }, /already the "heading" part/],
      ['edit_definition_node', { nodeId: 'grid' }, /send the content to change/],
      ['bind_definition_field', { nodeId: 'media', field: 'text', binding: { $prop: 'heading' } }, /binds when, unless, image/],
      ['style_definition_element', { nodeId: 'nope', scope: 'base', styles: [{ property: 'gap', value: null }] }, /no node "nope"/],
      ['style_definition_element', { scope: 'base', variant: { axis: 'tone', option: 'loud' }, styles: [{ property: 'gap', value: null }] }, /must be one of: default, muted, inverse/],
      ['style_definition_element', { scope: 'base', state: 'hover', styles: [{ property: 'gap', value: '1rem' }] }, /styles\[0\]\.property/],
      ['add_definition_variant', { axis: 'tone', option: 'muted', label: 'Muted' }, /already an option of tone/],
      ['manage_component_prop', { change: { action: 'add', prop: 'size', label: 'Size', type: 'enum', options: ['s', 'm'], default: 'xl' } }, /change\.default/],
      ['bind_definition_field', { nodeId: 'heading', field: 'text', binding: { $item: 'title' } }, /not inside a repeat/],
      ['style_definition_element', { partId: 'nope', scope: 'base', styles: [{ property: 'gap', value: null }] }, /no part "nope"/]
    ];
    for (const [name, args, message] of bad) {
      const r = await run(host, name, args);
      expect(r.ok, name).toBe(false);
      expect(errorOf(r).message, name).toMatch(message);
    }
    // Each problem is named by the field it is in.
    const fields = (r: { content: unknown }) => (r.content as { fields: Array<{ field: string }> }).fields.map((f) => f.field);
    expect(fields(await run(host, 'edit_definition_node', { nodeId: 'content', content: { text: 'Hi' } }))).toEqual(['content.text']);
    expect(fields(await run(host, 'style_definition_element', { scope: 'base', state: 'hover', styles: [{ property: 'gap', value: '1rem' }] }))).toEqual(['styles[0].property']);
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
    expect(session.state.components[id].variantAxes!.layout.options['media-start'].styles).toMatchObject({ content: { base: { gap: { token: 'space.lg' } } } });
    expect(session.state.components[id].tree!.nodes.lead.when).toEqual({ ref: { $prop: 'showLead' }, eq: true });
    expect((await run(host, 'bind_definition_field', { nodeId: 'eyebrow', field: 'unless', binding: { $prop: 'showLead' }, ne: false })).ok).toBe(true);
    expect(session.state.components[id].tree!.nodes.eyebrow.unless).toEqual({ ref: { $prop: 'showLead' }, ne: false });
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
    // A live design whose selected node is gone: nothing is limited to it, not even an addition to the contract.
    const gone = { ...host, definitionTarget: (): DefinitionTarget => ({ definitionId: id, nodeId: 'n_gone' }) };
    const revision = session.revision;
    expect(errorOf(await run(gone, 'manage_component_prop', { change: { action: 'add', prop: 'x', label: 'X', type: 'string' } })).message).toMatch(/no longer in the site/);
    expect(session.revision).toBe(revision);
  });
});

describe('UI state with the definition tools (#377)', () => {
  it('builds a toggle step by step: a yes/no state, a button that toggles it, a part shown while it is on, then removes it', async () => {
    const { session, id } = await hero();
    const host = hostFor(session, authorityOf(session.state, id, null));
    const def = () => session.state.components[id];
    // Offered from the start, so the first state can be added; reading state is offered once there is some.
    let tools = definitionTools(session.state, { definitionId: id })!;
    expect(JSON.stringify(prop(tool(tools, 'manage_component_state'), 'change'))).not.toContain('on_click');
    expect(JSON.stringify(prop(tool(tools, 'bind_definition_field'), 'binding'))).not.toContain('$state');
    const add = await run(host, 'manage_component_state', { change: { action: 'add', state: 'open', label: 'Details', type: 'boolean' } });
    expect(add.ok, JSON.stringify(add.content)).toBe(true);
    expect(def().state).toEqual({ open: { type: 'boolean', label: 'Details', initial: false } });
    tools = definitionTools(session.state, { definitionId: id })!;
    expect(prop(tool(tools, 'bind_definition_field'), 'binding').anyOf!.some((b) => b.properties?.$state?.enum?.join() === 'open')).toBe(true);
    const branches = prop(tool(tools, 'manage_component_state'), 'change').anyOf!;
    expect(branches.map((b) => b.properties!.action.enum![0])).toEqual(['add', 'remove', 'on_click']);
    expect(branches[2].properties!.nodeId.enum).toEqual(['primary', 'secondary']);

    expect((await run(host, 'manage_component_state', { change: { action: 'on_click', nodeId: 'secondary', op: 'toggle', state: 'open' } })).ok).toBe(true);
    expect(def().tree!.nodes.secondary).toMatchObject({ stateAction: { state: 'open', op: 'toggle' } });
    expect((await run(host, 'bind_definition_field', { nodeId: 'lead', field: 'when', binding: { $state: 'open' } })).ok).toBe(true);
    expect(def().tree!.nodes.lead.when).toEqual({ $state: 'open' });
    // Still used: the engine says by what, and nothing changes.
    const busy = await run(host, 'manage_component_state', { change: { action: 'remove', state: 'open' } });
    expect(busy.ok).toBe(false);
    expect(JSON.stringify(busy.content)).toMatch(/still used by/);
    expect((await run(host, 'manage_component_state', { change: { action: 'on_click', nodeId: 'secondary', op: 'none' } })).ok).toBe(true);
    expect((await run(host, 'bind_definition_field', { nodeId: 'lead', field: 'when', binding: null })).ok).toBe(true);
    expect((await run(host, 'manage_component_state', { change: { action: 'remove', state: 'open' } })).ok).toBe(true);
    expect(def().state).toBeUndefined();
  });

  it('names what a state call gets wrong, and applies nothing', async () => {
    const { session, id } = await hero();
    const host = hostFor(session, authorityOf(session.state, id, null));
    expect((await run(host, 'manage_component_state', { change: { action: 'add', state: 'plan', label: 'Plan', type: 'enum', options: ['monthly', 'annual'] } })).ok).toBe(true);
    const revision = session.revision;
    const fieldOf = async (name: string, args: unknown) => {
      const out = await run(host, name, args);
      expect(out.ok).toBe(false);
      const c = out.content as { message?: unknown };
      return typeof c.message === "string" ? c.message : JSON.stringify(c);
    };
    expect(await fieldOf('manage_component_state', { change: { action: 'add', state: 'plan', label: 'Again', type: 'boolean' } })).toMatch(/change\.state.*already has the UI state "plan"/);
    expect(await fieldOf('manage_component_state', { change: { action: 'add', state: 'tab', label: 'Tab', type: 'enum' } })).toMatch(/change\.options.*needs its option values/);
    expect(await fieldOf('manage_component_state', { change: { action: 'on_click', nodeId: 'primary', op: 'set', state: 'plan' } })).toMatch(/change\.value.*needs the value/);
    expect(await fieldOf('manage_component_state', { change: { action: 'on_click', nodeId: 'primary', op: 'set', state: 'plan', value: 'weekly' } })).toMatch(/not one of its options/);
    expect(await fieldOf('manage_component_state', { change: { action: 'on_click', nodeId: 'lead', op: 'next', state: 'plan' } })).toMatch(/"lead" is not a button/);
    expect(await fieldOf('bind_definition_field', { nodeId: 'lead', field: 'text', binding: { $state: 'plan' } })).toMatch(/bind it to when or unless/);
    expect(await fieldOf('bind_definition_field', { nodeId: 'lead', field: 'when', binding: { $state: 'period' } })).toMatch(/has no UI state "period"/);
    expect(session.revision).toBe(revision);
  });

  it('lets a run on a node selected in the design add a new state and wire its own buttons, but never change one the design has', async () => {
    const { session, id, owner } = await hero((s) => void s);
    const whole = hostFor(session, authorityOf(session.state, id, null));
    expect((await run(whole, 'manage_component_state', { change: { action: 'add', state: 'plan', label: 'Plan', type: 'enum', options: ['monthly', 'annual'] } })).ok).toBe(true);
    const selected = authorityOf(session.state, id, { owner, instancePath: [], nodeId: 'actions' });
    const host = hostFor(session, selected);
    expect((await run(host, 'manage_component_state', { change: { action: 'add', state: 'open', label: 'Open', type: 'boolean' } })).ok).toBe(true);
    expect((await run(host, 'manage_component_state', { change: { action: 'on_click', nodeId: 'primary', op: 'set', state: 'plan', value: 'annual' } })).ok).toBe(true);
    // Removing a state, or changing one the design has, reaches every button and panel using it.
    const tools = definitionTools(session.state, definitionTarget(selected)!)!;
    expect(prop(tool(tools, 'manage_component_state'), 'change').anyOf!.map((b) => b.properties!.action.enum![0])).toEqual(['add', 'on_click']);
    const relabel: EditOperation = { type: 'component.setState', definitionId: id, state: 'plan', schema: { type: 'enum', options: ['monthly', 'weekly'] } };
    expect(checkAuthority(session.state, [relabel], selected)).toBeTruthy();
    expect(checkAuthority(session.state, [{ type: 'component.removeState', definitionId: id, state: 'open' }], selected)).toBeTruthy();
  });
});
