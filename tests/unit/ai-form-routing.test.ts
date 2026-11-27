/**
 * The assistant never changes where a contact form sends visitors' messages without the user's say (#1128): its
 * batches are checked at commit, in the main process, against the project as they would leave it, however the
 * change is made, while every other edit to a form commits as before.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { InstanceNode, OwnerRef, ProjectState } from '@shared/types';

const env = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => env.userData, isPackaged: false } }));

const { createStarterState } = await import('@catalogue/starters');
const { applyOperations } = await import('@engine/apply');
const { ProjectSession } = await import('../../src/main/project/session');

const FORM = 'foundation.contact.form';
const SALES = 'https://forms.example.com/sales';
const EVIL = 'https://evil.example/f';

const dirs: string[] = [];
const temp = (name: string) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `so-ai-form-${name}-`)));
  dirs.push(d);
  return d;
};
beforeEach(() => {
  env.userData = temp('userdata');
});
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A blank site with a contact form on its home page that sends to Sales. */
function project() {
  let state = createStarterState('blank', 'Forms', false);
  const owner: OwnerRef = { kind: 'page', id: state.site.homePageId };
  const r = applyOperations(state, [{ type: 'node.insert', owner, parentId: null, componentId: 'contact.form', props: { provider: 'endpoint', endpoint: SALES } }]);
  state = r.state;
  return { state, owner, form: r.results[0].nodeId as string };
}

const endpointOf = (state: ProjectState, owner: OwnerRef, nodeId: string) => (state.pages[owner.id].nodes[nodeId] as InstanceNode).props.endpoint;

describe('an AI batch at commit', () => {
  it('is refused when it changes where a form sends, and nothing of it is saved', async () => {
    const { state, owner, form } = project();
    const s = await ProjectSession.create(temp('session'), state);
    const ops: EditOperation[] = [{ type: 'instance.setProp', owner, nodeId: form, prop: 'endpoint', value: EVIL }];
    const r = await s.apply({ operations: ops }, { label: 'AI', source: 'ai' });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('SCOPE_MISMATCH');
    expect(endpointOf(s.state, owner, form)).toBe(SALES);
    await s.close();
  });

  it('commits an ordinary edit to the same form', async () => {
    const { state, owner, form } = project();
    const s = await ProjectSession.create(temp('session'), state);
    const r = await s.apply({ operations: [{ type: 'instance.setProp', owner, nodeId: form, prop: 'heading', value: 'Write to us' }] }, { label: 'AI', source: 'ai' });
    expect(r.error).toBeUndefined();
    expect((s.state.pages[owner.id].nodes[form] as InstanceNode).props.heading).toBe('Write to us');
    await s.close();
  });

  it('leaves the user’s own edits alone', async () => {
    const { state, owner, form } = project();
    const s = await ProjectSession.create(temp('session'), state);
    const r = await s.apply({ operations: [{ type: 'instance.setProp', owner, nodeId: form, prop: 'endpoint', value: EVIL }] }, { label: 'Edit', source: 'user' });
    expect(r.error).toBeUndefined();
    expect(endpointOf(s.state, owner, form)).toBe(EVIL);
    expect(FORM).toBe((s.state.pages[owner.id].nodes[form] as InstanceNode).definitionId);
    await s.close();
  });
});
