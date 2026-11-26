/**
 * Required values in the Inspector (#748): a field the component requires says so in its name, says when its value is
 * empty, and an edit that would empty it is refused at that field (with the engine's message) instead of a toast.
 * Project health leads from a placement missing a value to that field.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Diagnostic, ProjectSnapshot } from '@shared/api';
import type { EditOperation } from '@shared/ops';
import type { InstanceNode, ProjectState, PropSchema } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { requiredSite } from '@engine/required';
import { validateState } from '@engine/validate';
import { isRequiredRefusal } from '@shared/required';
import { ProjectSession } from '../../src/main/project/session';
import { destinationForDiagnostic, destinationLabel } from '../../src/renderer/src/lib/destinations';

/** What the test uses of the renderer store, loaded by path: it reads `window`, outside the Node type-check project. */
interface StoreModule {
  applyOps(operations: EditOperation[], label: string, coalesceKey?: string, expectedRevision?: number): Promise<unknown>;
  claimRefusals<T>(sink: (e: { code: string; message: string; details?: unknown }) => boolean, commit: () => T): T;
  getState(): { snapshot: ProjectSnapshot | null; toasts: Array<{ text: string; kind: string }> };
  setState(patch: Record<string, unknown>): void;
}
type PropFieldProps = { name: string; schema: PropSchema; value: unknown; state: ProjectState; refused?: (at: { field?: string; itemId?: string }) => string | undefined } & Record<string, unknown>;
interface EditorsModule {
  PropField(props: PropFieldProps): unknown;
}

let store: StoreModule;
let editors: EditorsModule;
let session: ProjectSession | null = null;
const dirs: string[] = [];
const snapshot = (): ProjectSnapshot => ({ dir: 'x', workspaceKey: 'x#1', state: structuredClone(session!.state), revision: session!.revision, aiBusy: false, aiRunId: null, conflicts: [] }) as unknown as ProjectSnapshot;

beforeAll(async () => {
  // The preload bridge, as the renderer sees it, backed by a real project session.
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    builder: {
      platform: 'test',
      project: {
        snapshot: async () => snapshot(),
        apply: async (batch: { operations: EditOperation[]; expectedRevision?: number }, opts?: { label?: string; coalesceKey?: string }) => {
          const r = await session!.apply(batch, { label: opts?.label ?? 'Edit', coalesceKey: opts?.coalesceKey, source: 'user' });
          store.setState({ snapshot: snapshot() });
          return r;
        }
      }
    }
  };
  store = (await import(/* @vite-ignore */ '../../src/renderer/src/store')) as StoreModule;
  editors = (await import(/* @vite-ignore */ '../../src/renderer/src/panels/PropEditors')) as unknown as EditorsModule;
});

afterEach(async () => {
  await session?.close().catch(() => undefined);
  session = null;
  store.setState({ snapshot: null, toasts: [], pendingSave: 0 });
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

const home = (s: ProjectState) => ({ kind: 'page' as const, id: s.site.homePageId });

/** A "Pricing switch" with a required Monthly label and Plans whose Name is required, placed on Home. */
function pricing() {
  const s0 = createStarterState('blank', 'Required', false);
  const made = applyOperations(s0, [{ type: 'component.create', name: 'Pricing switch' }]);
  const definitionId = made.results[0].definitionId as string;
  let s = applyOperations(made.state, [
    { type: 'component.setPropSchema', definitionId, prop: 'monthly', schema: { type: 'string', label: 'Monthly label', default: 'Monthly', required: true } },
    { type: 'component.setPropSchema', definitionId, prop: 'note', schema: { type: 'string', label: 'Note', default: '' } },
    { type: 'component.setPropSchema', definitionId, prop: 'plans', schema: { type: 'list', label: 'Plans', itemLabel: 'Plan', fields: { name: { type: 'string', label: 'Name', default: '', required: true }, price: { type: 'string', label: 'Price', default: '' } }, default: [{ name: 'Basic' }, { name: '' }] } },
    { type: 'component.setPropSchema', definitionId, prop: 'action', schema: { type: 'object', label: 'Action', fields: { label: { type: 'string', label: 'Label', default: '', required: true }, link: { type: 'link', label: 'Link' } } } }
  ]).state;
  const put = applyOperations(s, [{ type: 'node.insert', owner: home(s), parentId: null, definitionId }]);
  s = put.state;
  const nodeId = put.results[0].nodeId as string;
  return { state: s, definitionId, nodeId, node: (st: ProjectState) => st.pages[st.site.homePageId].nodes[nodeId] as InstanceNode };
}

const render = (props: Omit<PropFieldProps, 'onChange' | 'onList' | 'onTable'>) => renderToStaticMarkup(createElement(editors.PropField as never, { onChange: () => undefined, onList: () => undefined, onTable: async () => true, ...props }));

describe('a required field in the Inspector', () => {
  it('says it is required in its name, and that it needs a value while it is empty', () => {
    const { state, definitionId } = pricing();
    const schema = state.components[definitionId].properties.monthly;
    const filled = render({ name: 'monthly', schema, value: 'Monthly', state });
    expect(filled).toMatch(/<label[^>]*>.*Monthly label.*required.*<\/label>/);
    expect(filled).not.toContain('field-error');
    expect(filled).not.toContain('aria-invalid');
    const empty = render({ name: 'monthly', schema, value: '  ', state });
    expect(empty).toContain('Required, but empty: it needs some text.');
    expect(empty).toContain('aria-invalid="true"');
    // An optional field says neither.
    const note = render({ name: 'note', schema: state.components[definitionId].properties.note, value: '', state });
    expect(note).not.toContain('required');
    expect(note).not.toContain('field-error');
  });

  it('shows a refused edit at the field with the engine’s message, in place of the empty note', () => {
    const { state, definitionId } = pricing();
    const schema = state.components[definitionId].properties.monthly;
    const message = 'Pricing switch → Monthly label is required: it needs some text.';
    const html = render({ name: 'monthly', schema, value: 'Monthly', state, refused: (at) => (at.field === undefined && at.itemId === undefined ? message : undefined) });
    expect(html).toContain(`<div class="field-error" `);
    expect(html).toContain(message);
    expect(html).toContain('aria-invalid="true"');
  });

  it('marks a list’s required item field, flags an incomplete item on its closed row, and names an object’s required field', () => {
    const { state, definitionId, node } = pricing();
    const def = state.components[definitionId];
    const plans = render({ name: 'plans', schema: def.properties.plans, value: node(state).props.plans, state });
    // Only the second plan, whose name is empty, is incomplete.
    expect(plans.match(/list-editor-incomplete/g)).toHaveLength(1);
    expect(plans).toContain('Incomplete: Name is required.');
    const action = render({ name: 'action', schema: def.properties.action, value: node(state).props.action, state, refused: (at) => (at.field === 'label' ? 'Refused here.' : undefined) });
    expect(action).toMatch(/Label.*required/);
    expect(action).toContain('Refused here.');
  });
});

describe('an edit that would empty a required value', () => {
  async function open() {
    const dir = mkdtempSync(join(tmpdir(), 'so-required-'));
    dirs.push(dir);
    const p = pricing();
    session = await ProjectSession.create(dir, p.state);
    store.setState({ snapshot: snapshot(), toasts: [] });
    return p;
  }

  it('is answered at the field that claims it: no toast, no history entry, and the value stays', async () => {
    const { nodeId, node } = await open();
    const before = session!.revision;
    const heard: Array<{ code: string; message: string; details?: unknown }> = [];
    const r = await store.claimRefusals((e) => (heard.push(e), isRequiredRefusal(e.details)), () => store.applyOps([{ type: 'instance.setProp', owner: home(session!.state), nodeId, prop: 'monthly', value: '' }], 'Edit Monthly label'));
    expect(r).toBeNull();
    expect(heard).toEqual([{ code: 'INVALID_ARGUMENT', message: 'Pricing switch → Monthly label is required: it needs some text.', details: { required: true } }]);
    expect(store.getState().toasts).toEqual([]);
    expect(session!.revision).toBe(before);
    expect(node(session!.state).props.monthly).toBe('Monthly');
  });

  it('is still a toast without a field to claim it, or when the refusal is about something else', async () => {
    const { nodeId } = await open();
    await store.applyOps([{ type: 'instance.setProp', owner: home(session!.state), nodeId, prop: 'monthly', value: ' ' }], 'Edit Monthly label');
    expect(store.getState().toasts.map((t) => [t.kind, t.text])).toEqual([['error', 'Pricing switch → Monthly label is required: it needs some text.']]);
    store.setState({ toasts: [] });
    // A refusal the field does not take (here, one that is not about a required value) is a toast as before.
    await store.claimRefusals((e) => isRequiredRefusal(e.details), () => store.applyOps([{ type: 'instance.setProp', owner: home(session!.state), nodeId, prop: 'nope', value: 'x' }], 'Edit'));
    expect(store.getState().toasts.map((t) => t.kind)).toEqual(['error']);
  });

  it('refuses emptying one plan’s filled name, while a plan already missing its name can have its price set', async () => {
    const { nodeId, node } = await open();
    const [basic, blank] = node(session!.state).props.plans as Array<{ id: string }>;
    const claimed: string[] = [];
    const sink = (e: { message: string; details?: unknown }) => isRequiredRefusal(e.details) && claimed.push(e.message) > 0;
    await store.claimRefusals(sink, () => store.applyOps([{ type: 'instance.setProp', owner: home(session!.state), nodeId, prop: 'plans', itemId: basic.id, field: 'name', value: '' }], 'Edit Name'));
    expect(claimed).toEqual(['Pricing switch → Plans → Plan 1 → Name is required: it needs some text.']);
    expect(await store.claimRefusals(sink, () => store.applyOps([{ type: 'instance.setProp', owner: home(session!.state), nodeId, prop: 'plans', itemId: blank.id, field: 'price', value: '$9' }], 'Edit Price'))).not.toBeNull();
    expect((node(session!.state).props.plans as Array<Record<string, unknown>>).map((p) => [p.name, p.price])).toEqual([['Basic', ''], ['', '$9']]);
    expect(store.getState().toasts).toEqual([]);
  });
});

describe('Project health’s way to a placement missing a value', () => {
  it('leads each finding to its field: the property, one field of an object, one field of a list item', () => {
    const { state, nodeId, node } = pricing();
    const blank = (node(state).props.plans as Array<{ id: string }>)[1].id;
    const emptied = structuredClone(state);
    (emptied.pages[emptied.site.homePageId].nodes[nodeId] as InstanceNode).props.monthly = '';
    const found = validateState(emptied, { sectionLinks: false }).filter((d) => d.code === 'PROP_REQUIRED_EMPTY');
    const owner = home(emptied);
    expect(found.map((d) => destinationForDiagnostic(emptied, d))).toEqual([
      { kind: 'prop', owner, nodeId, prop: 'monthly' },
      { kind: 'prop', owner, nodeId, prop: 'plans', itemId: blank, field: 'name' },
      { kind: 'prop', owner, nodeId, prop: 'action', field: 'label' }
    ]);
    expect(destinationLabel(destinationForDiagnostic(emptied, found[0])!)).toBe('Go to field');
  });

  it('reads no field from a key that is not a placement’s value', () => {
    const owner = { kind: 'page' as const, id: 'pg' };
    expect(requiredSite('default|c|title|', owner, 'n')).toBeNull();
    expect(requiredSite('page|pg|n|title', owner, 'n')).toBeNull();
    expect(requiredSite('page|pg|other|title|', owner, 'n')).toBeNull();
    expect(requiredSite('page|pg|n|title|', owner, 'n')).toEqual({ prop: 'title' });
    const d = { severity: 'error', code: 'PROP_REQUIRED_EMPTY', message: 'x', owner, nodeId: 'n', site: 'page|pg|n|title' } as Diagnostic;
    expect(destinationForDiagnostic(createStarterState('blank', 'X', false), d)).toBeNull();
  });
});
