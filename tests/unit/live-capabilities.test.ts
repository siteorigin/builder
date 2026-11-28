import { describe, expect, it } from 'vitest';
import { OPERATION_SCHEMAS, validateOperation } from '@shared/ops';
import { FORM_DESTINATIONS } from '@shared/form-contract';
import { canCall, canEditOperation, checkEditBatch, checkRpcRequest, COLLABORATOR_METHODS, COLLABORATOR_OPERATIONS, COPY_EDITOR_METHODS, HOST_ONLY_PROPS, LIVE_BATCH_MAX_COPIES, LIVE_BATCH_MAX_OPERATIONS, VIEWER_METHODS } from '@shared/live/capabilities';
import { COPY_EDITOR_OPERATIONS } from '@shared/live/copy-editor';
import { GUEST_ROLES, leastRole, narrower } from '@shared/live/limits';

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
  'source.upsert',
  'source.remove',
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
  // Turns a container in a component's design into a slot: a change to the definition every placement shows.
  'component.containerToSlot',
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
  'project.reviewEditions',
  'project.captureReviewEdition',
  'project.stopReviewCapture',
  'project.exportReviewSheet',
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
  'project.testSource',
  'project.saveSource',
  'project.syncSource',
  'project.sourceSecretNames',
  'project.setSourceSecret',
  'project.undo',
  'project.redo',
  'project.copy',
  'project.saveLocalState',
  'ai.providers',
  'ai.setKey',
  'ai.testProvider',
  'ai.localModels',
  'ai.localContext',
  'ai.conversations',
  'ai.newConversation',
  'ai.openConversation',
  'ai.renameConversation',
  'ai.deleteConversation',
  'ai.clearHistory',
  'ai.undoTurn',
  'ai.fixCode',
  'ai.cancelFix',
  'on',
  'platform',
  'constructor',
  '__proto__',
  'project.snapshot ',
  ''
];

describe('role methods', () => {
  it('lets a viewer read the project, and a copy editor and a collaborator also edit it', () => {
    expect(VIEWER_METHODS).toEqual(['project.snapshot', 'notes.list', 'notes.add']);
    expect(COPY_EDITOR_METHODS).toEqual(['project.snapshot', 'notes.list', 'notes.add', 'project.apply']);
    expect(COLLABORATOR_METHODS).toEqual(['project.snapshot', 'notes.list', 'notes.add', 'project.apply', 'notes.resolve', 'notes.delete', 'ai.send', 'ai.stop', 'ai.answer']);
    for (const role of ['viewer', 'copy-editor', 'collaborator'] as const) {
      expect(canCall(role, 'notes.list')).toBe(true);
      expect(canCall(role, 'notes.add')).toBe(true);
    }
    // Resolving and deleting notes stays with the host and collaborators.
    for (const role of ['viewer', 'copy-editor'] as const) {
      expect(canCall(role, 'notes.resolve')).toBe(false);
      expect(canCall(role, 'notes.delete')).toBe(false);
    }
    expect(canCall('collaborator', 'notes.resolve')).toBe(true);
    expect(canCall('collaborator', 'notes.delete')).toBe(true);
    expect(canCall('viewer', 'project.snapshot')).toBe(true);
    expect(canCall('viewer', 'project.apply')).toBe(false);
    for (const role of ['copy-editor', 'collaborator'] as const) {
      expect(canCall(role, 'project.snapshot')).toBe(true);
      expect(canCall(role, 'project.apply')).toBe(true);
    }
  });

  it('orders the roles by what each may do, so a guest holds the least of any still in play', () => {
    expect(GUEST_ROLES).toEqual(['viewer', 'copy-editor', 'collaborator']);
    expect(narrower('copy-editor', 'collaborator')).toBe(true);
    expect(narrower('viewer', 'copy-editor')).toBe(true);
    expect(narrower('collaborator', 'copy-editor')).toBe(false);
    expect(narrower('copy-editor', 'copy-editor')).toBe(false);
    expect(leastRole('collaborator')).toBe('collaborator');
    expect(leastRole('collaborator', 'copy-editor', 'collaborator')).toBe('copy-editor');
    expect(leastRole('copy-editor', 'collaborator', 'viewer', 'collaborator')).toBe('viewer');
    expect(leastRole('collaborator', 'collaborator', 'copy-editor')).toBe('copy-editor');
    expect(leastRole('copy-editor', 'viewer')).toBe('viewer');
  });

  it('lets a collaborator ask the host’s AI, which the host still has to allow, and never a viewer or a copy editor (#769)', () => {
    for (const method of ['ai.send', 'ai.stop', 'ai.answer']) {
      expect(canCall('collaborator', method), method).toBe(true);
      expect(canCall('viewer', method), method).toBe(false);
      expect(canCall('copy-editor', method), method).toBe(false);
    }
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

  it('allows visual edits to collaborators only, and a copy editor only the text and properties of what is placed', () => {
    for (const type of COLLABORATOR_OPERATIONS) {
      expect(canEditOperation('collaborator', type)).toBe(true);
      expect(canEditOperation('viewer', type)).toBe(false);
      expect(canEditOperation('copy-editor', type), type).toBe((COPY_EDITOR_OPERATIONS as readonly string[]).includes(type));
    }
    expect([...COPY_EDITOR_OPERATIONS].sort()).toEqual(['instance.setProp', 'node.setContent']);
  });

  it('refuses code, settings, theme, import and asset-library edits to both roles', () => {
    for (const role of GUEST_ROLES) for (const type of [...REFUSED_OPERATIONS, 'page.future', 'toString', '']) expect(canEditOperation(role, type), `${role} ${type}`).toBe(false);
  });
});

describe('checking a batch', () => {
  it('accepts a collaborator’s visual edits and returns them as parsed, not as sent', () => {
    const result = checkEditBatch('collaborator', { operations: [{ ...setText, note: 'dropped' }, setStyle], expectedRevision: 4, label: 'Edit text' });
    expect(result).toEqual({ ok: true, value: { operations: [setText, setStyle], expectedRevision: 4, label: 'Edit text' } });
  });

  it('keeps edits on pages and the shared header and footer', () => {
    expect(checkEditBatch('collaborator', { operations: [{ ...setText, owner: { kind: 'shell', id: 'header' } }] })).toMatchObject({ ok: true });
    // The same operations on a page are ordinary edits, so the refusals below are for where they land.
    for (const op of [{ type: 'node.setStateAction', owner: page, nodeId: 'n_button', action: null }, { type: 'node.setBinding', owner: page, nodeId: 'n_title', field: 'text', binding: { $entry: 'title' } }])
      expect(checkEditBatch('collaborator', { operations: [op] }), op.type).toMatchObject({ ok: true });
    // Component definitions and collection layouts are shared designs, whatever operation would reach them.
    for (const owner of [{ kind: 'component', id: 'cmp_hero' }, { kind: 'template', id: 'posts' }]) {
      for (const op of [
        { ...setText, owner },
        { ...setStyle, owner },
        { type: 'node.setStateAction', owner, nodeId: 'n_button', action: null },
        { type: 'node.setBinding', owner, nodeId: 'n_title', field: 'text', binding: { $entry: 'title' } }
      ])
        expect(checkEditBatch('collaborator', { operations: [op] }), `${op.type} in ${owner.kind}`).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED', operationIndex: 0 } });
      expect(checkEditBatch('collaborator', { operations: [{ type: 'node.copy', owner: page, nodeId: 'n_card', toOwner: owner }] })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED', operationIndex: 0 } });
      // Every operation of a batch is checked, not just the first.
      expect(checkEditBatch('collaborator', { operations: [setText, setStyle, { ...setText, owner }] })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED', operationIndex: 2 } });
    }
  });

  it('leaves where a contact form sends its messages to the host', () => {
    // Exactly the settings that send a form's messages to someone's account are protected.
    expect([...HOST_ONLY_PROPS].sort()).toEqual([...FORM_DESTINATIONS].sort());
    for (const prop of HOST_ONLY_PROPS) {
      expect(checkEditBatch('collaborator', { operations: [{ type: 'instance.setProp', owner: page, nodeId: 'n_form', prop, value: 'https://elsewhere.example/f/1' }] }), prop).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED', operationIndex: 0 } });
      expect(checkEditBatch('collaborator', { operations: [{ type: 'node.insert', owner: page, parentId: null, componentId: 'contact.form', props: { heading: 'Write to us', [prop]: 'x' } }] }), prop).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED', operationIndex: 0 } });
    }
    // The form's other properties, and inserting one without its settings, are ordinary edits; so is a property
    // that only shares a name with a form setting on another component.
    expect(checkEditBatch('collaborator', { operations: [{ type: 'instance.setProp', owner: page, nodeId: 'n_form', prop: 'heading', value: 'Say hello' }] })).toMatchObject({ ok: true });
    expect(checkEditBatch('collaborator', { operations: [{ type: 'instance.setProp', owner: page, nodeId: 'n_card', prop: 'provider', value: 'Acme Plumbing' }] })).toMatchObject({ ok: true });
    expect(checkEditBatch('collaborator', { operations: [{ type: 'node.insert', owner: page, parentId: null, componentId: 'contact.form', props: { heading: 'Write to us' } }] })).toMatchObject({ ok: true });
  });

  it('lets a collaborator rename, move and lay out a page, but not publish, hide or redirect it', () => {
    expect(
      checkEditBatch('collaborator', {
        operations: [{ type: 'page.update', pageId: 'pg_about', title: 'About us', route: '/about-us/', navLabel: 'About', showHeader: false, showFooter: true, socialImage: 'img_1', byline: 'By Ana Ruiz', excerpt: 'Spring workshop dates' }]
      })
    ).toMatchObject({ ok: true });
    for (const field of [{ draft: false }, { draft: true }, { noindex: true }, { searchHidden: true }, { canonical: 'https://elsewhere.example/' }, { newsHidden: true }, { structuredData: { type: 'WebPage' } }, { articleDate: '2026-01-01' }, { article: false }])
      expect(checkEditBatch('collaborator', { operations: [{ type: 'page.update', pageId: 'pg_about', title: 'About', ...field }] }), Object.keys(field)[0]).toMatchObject({
        ok: false,
        error: { code: 'PERMISSION_DENIED', message: expect.stringContaining(Object.keys(field)[0]), operationIndex: 0 }
      });
  });

  it('holds a batch to a few copies, which could otherwise each double the page', () => {
    const copy = { type: 'node.duplicate', owner: page, nodeId: 'n_section' };
    expect(checkEditBatch('collaborator', { operations: Array(LIVE_BATCH_MAX_COPIES).fill(copy) })).toMatchObject({ ok: true });
    expect(checkEditBatch('collaborator', { operations: [...Array(LIVE_BATCH_MAX_COPIES).fill(copy), { type: 'page.duplicate', pageId: 'pg_home' }] })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT', operationIndex: LIVE_BATCH_MAX_COPIES } });
  });

  it('keeps a draft duplicate to the host', () => {
    expect(checkEditBatch('collaborator', { operations: [{ type: 'page.duplicate', pageId: 'pg_about' }] })).toMatchObject({ ok: true });
    expect(checkEditBatch('collaborator', { operations: [{ type: 'page.duplicate', pageId: 'pg_about', draft: true }] })).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED', message: expect.stringContaining('Only the host') } });
  });

  it('lets a collaborator add a page, but not date it, keep it out of News, or make it a draft', () => {
    expect(checkEditBatch('collaborator', { operations: [{ type: 'page.create', title: 'Workshops', route: '/workshops/', starter: 'services', addToNavigation: true, byline: 'By Ana Ruiz', excerpt: 'Spring dates' }] })).toMatchObject({ ok: true });
    for (const field of [{ articleDate: '2026-01-01' }, { newsHidden: true }, { newsHidden: false }, { starter: 'article' }, { draft: true }, { draft: false }])
      expect(checkEditBatch('collaborator', { operations: [{ type: 'page.create', title: 'News', ...field }] }), Object.keys(field)[0]).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED', operationIndex: 0 } });
  });

  it('takes a copy editor’s text and property edits, and refuses every structural one before anything runs', () => {
    const setProp = { type: 'instance.setProp', owner: page, nodeId: 'n_hero', prop: 'heading', value: 'Fresh bread' };
    expect(checkEditBatch('copy-editor', { operations: [setText, setProp], expectedRevision: 2, label: 'Reword' })).toEqual({ ok: true, value: { operations: [setText, setProp], expectedRevision: 2, label: 'Reword' } });
    // Layout, styles and structure, each an edit a collaborator may make.
    for (const op of [
      setStyle,
      { type: 'node.remove', owner: page, nodeId: 'n_title' },
      { type: 'node.insert', owner: page, parentId: null, primitive: 'paragraph', text: 'New' },
      { type: 'node.move', owner: page, nodeId: 'n_title', parentId: null, index: 0 },
      { type: 'node.duplicate', owner: page, nodeId: 'n_title' },
      { type: 'instance.setVariant', owner: page, nodeId: 'n_hero', axis: 'tone', variant: 'muted' },
      { type: 'page.update', pageId: 'pg_home', title: 'Home' },
      { type: 'page.create', title: 'Workshops' },
      { type: 'token.set', tokenId: 'color.primary', value: '#123456' }
    ]) {
      expect(checkEditBatch('collaborator', { operations: [op] }), op.type).toMatchObject({ ok: true });
      expect(checkEditBatch('copy-editor', { operations: [setText, op] }), op.type).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED', operationIndex: 1 } });
    }
    // The operations it may make, reaching past what it may change: the shared header, a list item's field, a binding,
    // where a contact form sends, an element's link.
    for (const op of [
      { ...setText, owner: { kind: 'shell', id: 'header' } },
      { ...setProp, itemId: 'i_1' },
      { ...setProp, field: 'title' },
      { ...setProp, value: { $entry: 'title' } },
      { ...setText, value: [{ type: 'p', children: [{ text: { $prop: 'heading' } }] }] },
      { ...setProp, prop: 'endpoint', value: 'https://evil.example/f' },
      { ...setText, field: 'link', value: { href: 'https://evil.example/' } }
    ])
      expect(checkEditBatch('copy-editor', { operations: [op] }), JSON.stringify(op)).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED', operationIndex: 0 } });
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
    expect(checkEditBatch('collaborator', { operations: [setText, [setText]] })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT', operationIndex: 1 } });
    expect(checkEditBatch('collaborator', { operations: [JSON.parse('{"type":"node.setContent","__proto__":{"x":1},"owner":{"kind":"page","id":"pg_home"},"nodeId":"n","field":"text","value":"x"}')] })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT', operationIndex: 0 } });
    // A reserved name inside a list of IDs is refused too, before the engine looks it up.
    for (const reserved of ['__proto__', 'constructor', 'prototype'])
      expect(checkEditBatch('collaborator', { operations: [{ type: 'page.reorder', pageIds: ['pg_home', reserved] }] }), reserved).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT', operationIndex: 0 } });
    // Content may hold those words, in a property of any name.
    expect(validateOperation({ type: 'node.insert', owner: page, parentId: null, componentId: 'content.text', props: { careerPath: ['prototype'], memberIds: ['constructor'] } })).toMatchObject({ ok: true });
    expect(validateOperation({ type: 'node.wrap', owner: page, nodeIds: ['n_1', 'constructor'], primitive: 'row' })).toMatchObject({ ok: false });
    expect(validateOperation({ type: 'node.wrap', owner: page, nodeIds: ['n_1', 'n_2'], primitive: 'row' })).toMatchObject({ ok: true });
    expect(validateOperation({ type: 'page.reorder', pageIds: ['pg_home', 'pg_about'] })).toMatchObject({ ok: true });
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

describe('checking an AI call (#769)', () => {
  const page = { scope: 'page', pageId: 'p1', selection: null, viewport: 1200 };
  const heading = { owner: { kind: 'page', id: 'p1' }, instancePath: [], nodeId: 'n1' };
  const header = { owner: { kind: 'shell', id: 'header' }, instancePath: [], nodeId: 'logo' };

  it('takes a request about the page shown, or the element selected there or in the header, trimmed', () => {
    expect(checkRpcRequest('collaborator', 'ai.send', ['  Make the heading bigger  ', page])).toEqual({ ok: true, value: { method: 'ai.send', args: ['Make the heading bigger', page] } });
    expect(checkRpcRequest('collaborator', 'ai.send', ['Bolder', { ...page, scope: 'selection', selection: heading, selectionLabel: 'Home → Heading' }])).toMatchObject({ ok: true, value: { args: ['Bolder', { scope: 'selection', selection: heading, selectionLabel: 'Home → Heading' }] } });
    expect(checkRpcRequest('collaborator', 'ai.send', ['Bolder', { ...page, scope: 'selection', selection: header }])).toEqual({ ok: true, value: { method: 'ai.send', args: ['Bolder', { ...page, scope: 'selection', selection: header }] } });
    expect(checkRpcRequest('collaborator', 'ai.stop', ['run-1'])).toEqual({ ok: true, value: { method: 'ai.stop', args: ['run-1'] } });
    expect(checkRpcRequest('collaborator', 'ai.answer', ['run-1', 'q1', ' Yes '])).toEqual({ ok: true, value: { method: 'ai.answer', args: ['run-1', 'q1', 'Yes'] } });
  });

  it('refuses a viewer, and anything a request can carry on the host that a guest never chooses', () => {
    for (const [method, args] of [['ai.send', ['Hi', page]], ['ai.stop', ['run-1']], ['ai.answer', ['run-1', 'q1', 'Yes']]] as const)
      expect(checkRpcRequest('viewer', method, [...args]), method).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    const refused = (args: unknown[]) => expect(checkRpcRequest('collaborator', 'ai.send', args), JSON.stringify(args)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    refused(['   ', page]);
    refused(['x'.repeat(8001), page]);
    refused(['Hi']);
    refused(['Hi', page, 'conversation-1']);
    // A model, a mode, a component edited everywhere, a post, a layout, attached images or the whole site: the host's.
    for (const extra of [{ recipient: { provider: 'openai', model: 'x' } }, { mode: 'ask' }, { component: { id: 'c', name: 'C' } }, { post: { collectionId: 'c', entryId: 'e', title: 't' } }, { template: { collectionId: 'c', name: 'C' } }, { assetIds: ['a1'] }, { task: 'component' }])
      refused(['Hi', { ...page, ...extra }]);
    refused(['Hi', { ...page, scope: 'site' }]);
    // A selection request names its selection, on the page it is about or in the shared header and footer.
    refused(['Hi', { ...page, scope: 'selection' }]);
    refused(['Hi', { ...page, selection: heading }]);
    refused(['Hi', { ...page, scope: 'selection', selection: { ...heading, owner: { kind: 'page', id: 'p2' } } }]);
    refused(['Hi', { ...page, scope: 'selection', selection: { ...heading, owner: { kind: 'component', id: 'card' } } }]);
    refused(['Hi', { ...page, viewport: 50 }]);
    refused(['Hi', { ...page, viewport: 8193 }]);
    expect(checkRpcRequest('collaborator', 'ai.stop', [])).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(checkRpcRequest('collaborator', 'ai.answer', ['run-1', 'q1', ''])).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(checkRpcRequest('collaborator', 'ai.answer', ['run-1', 'q1', { assetId: 'a1' }])).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
  });
});
