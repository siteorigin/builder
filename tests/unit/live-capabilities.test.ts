import { describe, expect, it } from 'vitest';
import { OPERATION_SCHEMAS } from '@shared/ops';
import { canCall, canEditOperation, checkEditBatch, checkRpcRequest, COLLABORATOR_METHODS, COLLABORATOR_OPERATIONS, LIVE_BATCH_MAX_OPERATIONS, VIEWER_METHODS } from '@shared/live/capabilities';
import { GUEST_ROLES } from '@shared/live/limits';

const page = { kind: 'page', id: 'pg_home' } as const;
const setText = { type: 'node.setContent', owner: page, nodeId: 'n_title', field: 'text', value: 'Hello' };
const setStyle = { type: 'node.setStyle', owner: page, nodeId: 'n_title', scope: 'base', property: 'color', value: '#123456' };
const updateSource = { type: 'component.updateSource', definitionId: 'cmp_hero', source: '<script>alert(1)</script>' };

/**
 * Every operation a collaborator is refused, so that together with COLLABORATOR_OPERATIONS this lists each operation
 * type exactly once. A new operation fails the partition test below until someone decides which list it belongs in;
 * until then it is refused.
 */
const REFUSED_OPERATIONS = [
  'node.paste',
  'site.update',
  'brief.update',
  'redirect.add',
  'redirect.update',
  'redirect.remove',
  'component.create',
  'component.upsert',
  'component.createFromNode',
  'component.makeUnique',
  'component.duplicate',
  'component.rename',
  'component.setInsertAs',
  'component.fork',
  'component.convertToCode',
  'component.createCode',
  'component.updateSource',
  'component.remove',
  'component.import',
  'component.setPropSchema',
  'component.removePropSchema',
  'component.orderProperties',
  'component.setPropDefault',
  'component.setState',
  'component.removeState',
  'component.setPart',
  'component.removePart',
  'component.setVariant',
  'component.removeVariant',
  'component.setSlot',
  'component.removeSlot',
  'theme.apply',
  'theme.refresh',
  'collection.create',
  'collection.update',
  'collection.remove',
  'collection.createTerm',
  'collection.renameTerm',
  'collection.removeTerm',
  'entry.create',
  'entry.update',
  'entry.reorder',
  'entry.remove',
  'asset.add',
  'asset.update',
  'asset.remove',
  'asset.replace',
  'asset.relink'
];

/** Host-only BuilderApi methods: projects, dialogs, export, settings and credentials, AI, source, versions, conflicts and history. */
const HOST_ONLY_METHODS = [
  'app.getSettings',
  'app.setSettings',
  'app.openExternal',
  'dialogs.chooseFolder',
  'dialogs.chooseImages',
  'projects.recents',
  'projects.open',
  'projects.close',
  'projects.duplicate',
  'projects.reveal',
  'project.exportSource',
  'project.exportStatic',
  'project.exportComponent',
  'project.importComponent',
  'project.importAssets',
  'project.readSource',
  'project.generatedSource',
  'project.validateSource',
  'project.restoreGenerated',
  'project.resolveConflict',
  'project.unlock',
  'project.saveVersion',
  'project.restoreVersion',
  'project.undo',
  'project.redo',
  'project.copy',
  'project.saveLocalState',
  'ai.providers',
  'ai.setKey',
  'ai.testProvider',
  'ai.send',
  'ai.fixCode',
  'ai.answer',
  'on',
  'platform',
  'constructor',
  '__proto__',
  'project.snapshot ',
  ''
];

describe('role methods', () => {
  it('lets a viewer read the project, and a collaborator also edit it', () => {
    expect(VIEWER_METHODS).toEqual(['project.snapshot']);
    expect(COLLABORATOR_METHODS).toEqual(['project.snapshot', 'project.apply']);
    expect(canCall('viewer', 'project.snapshot')).toBe(true);
    expect(canCall('viewer', 'project.apply')).toBe(false);
    expect(canCall('collaborator', 'project.snapshot')).toBe(true);
    expect(canCall('collaborator', 'project.apply')).toBe(true);
  });

  it('refuses every host-only method to both roles', () => {
    for (const role of GUEST_ROLES) for (const method of HOST_ONLY_METHODS) expect(canCall(role, method), `${role} ${method}`).toBe(false);
  });

  it('grants nothing to a role it does not know', () => {
    expect(canCall('host' as never, 'project.snapshot')).toBe(false);
    expect(canCall('toString' as never, 'project.snapshot')).toBe(false);
    expect(canEditOperation('host' as never, 'node.setStyle')).toBe(false);
  });
});

describe('role operations', () => {
  it('sorts every operation type into exactly one of allowed and refused', () => {
    const allowed = [...COLLABORATOR_OPERATIONS];
    expect(new Set(allowed).size).toBe(allowed.length);
    expect(new Set(REFUSED_OPERATIONS).size).toBe(REFUSED_OPERATIONS.length);
    expect(allowed.filter((t) => REFUSED_OPERATIONS.includes(t))).toEqual([]);
    expect([...allowed, ...REFUSED_OPERATIONS].sort()).toEqual(Object.keys(OPERATION_SCHEMAS).sort());
  });

  it('allows visual edits to collaborators only', () => {
    for (const type of COLLABORATOR_OPERATIONS) {
      expect(canEditOperation('collaborator', type)).toBe(true);
      expect(canEditOperation('viewer', type)).toBe(false);
    }
  });

  it('refuses code, settings, theme, import and asset-library edits to both roles', () => {
    for (const role of GUEST_ROLES) for (const type of [...REFUSED_OPERATIONS, 'page.future', 'toString', '']) expect(canEditOperation(role, type), `${role} ${type}`).toBe(false);
  });
});

describe('checking a batch', () => {
  it('accepts a collaborator’s visual edits and returns them parsed', () => {
    const result = checkEditBatch('collaborator', { operations: [setText, setStyle], expectedRevision: 4, label: 'Edit text' });
    expect(result).toEqual({ ok: true, value: { operations: [expect.objectContaining({ type: 'node.setContent' }), expect.objectContaining({ type: 'node.setStyle' })], expectedRevision: 4, label: 'Edit text' } });
  });

  it('refuses any edit from a viewer', () => {
    expect(checkEditBatch('viewer', { operations: [setText] })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
  });

  it('refuses a whole batch when one operation is not allowed, naming it', () => {
    expect(checkEditBatch('collaborator', { operations: [setText, updateSource] })).toEqual({
      ok: false,
      error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('component.updateSource'), recoverable: false, operationIndex: 1 }
    });
    for (const op of [
      { type: 'component.createCode', name: 'X', source: '<p>x</p>' },
      { type: 'component.convertToCode', owner: page, nodeId: 'n_1' },
      { type: 'component.fork', definitionId: 'cmp_hero' },
      { type: 'site.update', baseUrl: 'https://evil.example' },
      { type: 'theme.apply', themeId: 'other' },
      { type: 'asset.relink', assetId: 'a1', file: 'static/assets/a.png', mime: 'image/png', bytes: 1, hash: 'x' }
    ])
      expect(checkEditBatch('collaborator', { operations: [op] }), op.type).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED', operationIndex: 0 } });
  });

  it('refuses an allowed operation that is not valid, before anything runs', () => {
    expect(checkEditBatch('collaborator', { operations: [setText, { ...setStyle, nodeId: undefined }] })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT', operationIndex: 1 } });
    // Reserved lookup names are refused as the local pipeline refuses them.
    expect(checkEditBatch('collaborator', { operations: [{ ...setText, nodeId: '__proto__' }] })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT', operationIndex: 0 } });
    expect(checkEditBatch('collaborator', { operations: [{ nodeId: 'n_1' }] })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT', operationIndex: 0 } });
    expect(checkEditBatch('collaborator', { operations: [null] })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT', operationIndex: 0 } });
  });

  it('refuses a batch that is not exactly a guest’s batch', () => {
    for (const bad of [
      null,
      [],
      { operations: [] },
      { operations: Array.from({ length: LIVE_BATCH_MAX_OPERATIONS + 1 }, () => setText) },
      { operations: [setText], expectedRevision: -1 },
      { operations: [setText], label: 'x'.repeat(121) },
      // The host chooses the opening and the history key; a guest naming them is refused.
      { operations: [setText], opening: '/Users/host/site#1' },
      { operations: [setText], coalesceKey: 'k' },
      { operations: [setText], scope: { kind: 'site', targetIds: [] } }
    ])
      expect(checkEditBatch('collaborator', bad)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
  });
});

describe('checking a call', () => {
  it('passes allowed calls through with their checked arguments', () => {
    expect(checkRpcRequest('viewer', 'project.snapshot', [])).toEqual({ ok: true, value: { method: 'project.snapshot', args: [] } });
    expect(checkRpcRequest('collaborator', 'project.apply', [{ operations: [setText] }])).toMatchObject({ ok: true, value: { method: 'project.apply', args: [{ operations: [{ type: 'node.setContent' }] }] } });
  });

  it('refuses methods the role does not have, and extra or missing arguments', () => {
    expect(checkRpcRequest('viewer', 'project.apply', [{ operations: [setText] }])).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    for (const role of GUEST_ROLES) for (const method of HOST_ONLY_METHODS) expect(checkRpcRequest(role, method, [])).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(checkRpcRequest('viewer', 'project.snapshot', ['extra'])).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    // The local API's options object (label, coalesceKey, opening) never comes from a guest.
    expect(checkRpcRequest('collaborator', 'project.apply', [{ operations: [setText] }, { opening: 'x' }])).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(checkRpcRequest('collaborator', 'project.apply', [])).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(checkRpcRequest('collaborator', 'project.apply', [{ operations: [updateSource] }])).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED', operationIndex: 0 } });
  });
});
