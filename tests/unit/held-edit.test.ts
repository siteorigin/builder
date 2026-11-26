import { describe, expect, it } from 'vitest';
import type { EditOperation } from '@shared/ops';
import type { InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { listThemes } from '@catalogue/index';
import { applyOperations } from '@engine/apply';
import { checkHeld, fieldKey, heldPrompt, readFields, shownField, typedText } from '../../src/renderer/src/lib/held';
import { runPhase, settledState } from '../../src/renderer/src/lib/savestate';
import { saveStatusAnnouncement as saveAnnouncement, toolbarAnnouncement, unseenRunAnnouncement } from '../../src/renderer/src/lib/announce';

const fresh = () => createStarterState('business', 'Test Studio', false);
const about = (s: ProjectState) => Object.values(s.pages).find((p) => p.title === 'About')!.id;
const apply = (s: ProjectState, ops: EditOperation[]) => applyOperations(s, ops).state;

/** Hold `ops` against `base` and check them against `now`, as the handoff does. */
function check(base: ProjectState, now: ProjectState, ops: EditOperation[]) {
  const reads = readFields(base, ops);
  expect(reads?.every((r) => r.found)).toBe(true);
  return checkHeld(now, ops, reads!.map((r) => (r.found ? r.value : undefined)));
}

/** An instance whose component has a list property with items that have a text field. */
function listInstance(s: ProjectState) {
  const trees = [
    ...Object.values(s.pages).map((p) => ({ owner: { kind: 'page' as const, id: p.id }, tree: p })),
    { owner: { kind: 'shell' as const, id: 'header' }, tree: s.site.shell.header },
    { owner: { kind: 'shell' as const, id: 'footer' }, tree: s.site.shell.footer }
  ];
  for (const { owner, tree } of trees)
    for (const n of Object.values(tree.nodes)) {
      if (n.kind !== 'instance') continue;
      const def = s.components[n.definitionId];
      const list = Object.entries(def.properties).find(([k, p]) => p.type === 'list' && Array.isArray(n.props[k]) && (n.props[k] as unknown[]).length >= 2);
      if (!list) continue;
      const [prop, schema] = list as [string, { fields: Record<string, { type: string }> }];
      const field = Object.entries(schema.fields).find(([, f]) => f.type === 'string')?.[0];
      if (!field) continue;
      return { owner, node: n as InstanceNode, prop, field, items: n.props[prop] as Array<{ id: string } & Record<string, unknown>> };
    }
  throw new Error('No list instance in the starter');
}

describe('held edit field check', () => {
  it('applies when nothing changed (a pending clarification)', () => {
    const s = fresh();
    expect(check(s, s, [{ type: 'page.update', pageId: about(s), seoTitle: 'Meet our design team' }])).toEqual({ kind: 'apply' });
  });

  it('applies when the AI changed another field of the same page, and refuses when it changed this one', () => {
    const s = fresh();
    const op: EditOperation = { type: 'page.update', pageId: about(s), seoTitle: 'Mine' };
    // The AI's description is in the base; the restored page differs there, not in the browser title.
    const aiDescribed = apply(s, [{ type: 'page.update', pageId: about(s), description: 'AI words' }]);
    expect(check(aiDescribed, s, [op])).toEqual({ kind: 'apply' });
    const aiTitled = apply(s, [{ type: 'page.update', pageId: about(s), seoTitle: 'AI title' }]);
    expect(check(aiTitled, s, [op])).toEqual({ kind: 'changed', current: [{ seoTitle: undefined }] });
    // Typing the very value the AI had set still writes over what stopping restored: not safe either.
    expect(check(aiTitled, s, [{ ...op, seoTitle: 'AI title' }]).kind).toBe('changed');
  });

  it('reports a page the AI created and stopping removed as gone', () => {
    const s = fresh();
    const withTeam = apply(s, [{ type: 'page.create', title: 'Team' }]);
    const team = Object.values(withTeam.pages).find((p) => p.title === 'Team')!.id;
    expect(check(withTeam, s, [{ type: 'page.update', pageId: team, seoTitle: 'Our people' }])).toEqual({ kind: 'gone', what: 'page' });
  });

  it('finds a list item by its ID: a reordered item still applies, a removed one is gone', () => {
    const s = fresh();
    const { owner, node, prop, field, items } = listInstance(s);
    const [first, second] = items;
    const op: EditOperation = { type: 'instance.setProp', owner, nodeId: node.id, prop, itemId: second.id, field, value: 'Typed' };
    // The AI moved the item and stopping moved it back: same item, same value.
    const moved = apply(s, [{ type: 'instance.listMove', owner, nodeId: node.id, prop, itemId: second.id, index: 0 }]);
    expect(check(moved, s, [op])).toEqual({ kind: 'apply' });
    // The AI changed another item only.
    const otherChanged = apply(s, [{ type: 'instance.setProp', owner, nodeId: node.id, prop, itemId: first.id, field, value: 'AI' }]);
    expect(check(otherChanged, s, [op])).toEqual({ kind: 'apply' });
    // The AI changed the very item and field the author edited.
    const sameChanged = apply(s, [{ type: 'instance.setProp', owner, nodeId: node.id, prop, itemId: second.id, field, value: 'AI' }]);
    expect(check(sameChanged, s, [op])).toEqual({ kind: 'changed', current: [expect.objectContaining({ value: second[field] })] });
    // The item the author edited was added by the AI.
    const added = applyOperations(s, [{ type: 'instance.listInsert', owner, nodeId: node.id, prop, item: { [field]: 'New' } }]);
    const newId = (added.results[0] as { itemId: string }).itemId;
    expect(check(added.state, s, [{ ...op, itemId: newId }])).toEqual({ kind: 'gone', what: 'list item' });
  });

  it('reports an element the AI inserted as gone', () => {
    const s = fresh();
    const page = about(s);
    const r = applyOperations(s, [{ type: 'node.insert', owner: { kind: 'page', id: page }, parentId: null, index: 0, componentId: 'layout.section' }]);
    const nodeId = (r.results[0] as { nodeId: string }).nodeId;
    expect(check(r.state, s, [{ type: 'node.rename', owner: { kind: 'page', id: page }, nodeId, name: 'Intro' }])).toEqual({ kind: 'gone', what: 'element' });
  });

  it('reads a theme style with its theme, so a style whose default the AI changed is not applied blindly', () => {
    const s = fresh();
    const op: EditOperation = { type: 'token.set', tokenId: 'color.brand', value: '#123456' };
    expect(check(s, s, [op])).toEqual({ kind: 'apply' });
    const aiBrand = apply(s, [{ type: 'token.set', tokenId: 'color.brand', value: '#000080' }]);
    expect(check(aiBrand, s, [op]).kind).toBe('changed');
    // The AI switched theme, so the style's default is another theme's: stopping switched it back.
    const other = listThemes().find((t) => t.id !== s.site.themeId)!;
    const aiTheme = apply(s, [{ type: 'theme.apply', themeId: other.id }]);
    expect(Object.hasOwn(aiTheme.tokens.overrides, 'color.brand')).toBe(Object.hasOwn(s.tokens.overrides, 'color.brand'));
    expect(check(aiTheme, s, [op]).kind).toBe('changed');
  });

  it('reads what decides where and how an instance edit lands, not only the stored value', () => {
    const s = fresh();
    const { owner, node, prop } = listInstance(s);
    const def = s.components[node.definitionId];
    // A property left unset shows its default: the AI changing that default changes what the author saw.
    const scalar = Object.entries(def.properties).find(([k, p]) => p.type === 'string' && node.props[k] === undefined)?.[0] ?? Object.keys(def.properties).find((k) => k !== prop)!;
    const propOp: EditOperation = { type: 'instance.setProp', owner, nodeId: node.id, prop: scalar, value: 'Typed' };
    const newDefault = structuredClone(s);
    (newDefault.components[node.definitionId].properties[scalar] as { default: unknown }).default = 'AI default';
    expect(check(newDefault, s, [propOp]).kind).toBe('changed');
    // Empty text is a value: stopping that restores an unset property (its default shows) is a change.
    const emptied = structuredClone(s);
    (emptied.pages[owner.id] ?? emptied.site.shell[owner.id as 'header']).nodes[node.id] = { ...node, props: { ...node.props, [scalar]: '' } };
    const restoredUnset = structuredClone(s);
    delete ((restoredUnset.pages[owner.id] ?? restoredUnset.site.shell[owner.id as 'header']).nodes[node.id] as InstanceNode).props[scalar];
    expect(check(emptied, restoredUnset, [propOp]).kind).toBe('changed');
    // A style on a part lands on the element the part names: the AI pointing it elsewhere is a change.
    const partId = Object.keys(def.parts).find((p) => p !== 'root') ?? 'root';
    const styleOp: EditOperation = { type: 'node.setStyle', owner, nodeId: node.id, partId, scope: 'base', property: 'gap', value: null };
    const repointed = structuredClone(s);
    repointed.components[node.definitionId].parts[partId] = { ...def.parts[partId], nodeId: 'n_elsewhere' };
    expect(check(s, s, [styleOp])).toEqual({ kind: 'apply' });
    expect(check(repointed, s, [styleOp]).kind).toBe('changed');
  });

  it('holds one card\'s own style: a reorder keeps it, a change to it conflicts, and a removed card is gone (#81)', () => {
    const s = fresh();
    const home = s.pages[s.site.homePageId];
    const grid = home.rootIds.map((id) => home.nodes[id] as InstanceNode).find((n) => s.components[n.definitionId].componentId === 'features.grid')!;
    const owner = { kind: 'page' as const, id: home.id };
    const [first, second] = (grid.props.items as Array<{ id: string }>).map((i) => i.id);
    const op: EditOperation = { type: 'node.setStyle', owner, nodeId: grid.id, partId: 'card', itemId: second, scope: 'base', property: 'background', value: '#dbeeff' };
    expect(check(s, apply(s, [{ type: 'instance.listMove', owner, nodeId: grid.id, prop: 'items', itemId: second, index: 0 }]), [op])).toEqual({ kind: 'apply' });
    // A sibling's own style is a different field.
    expect(check(s, apply(s, [{ ...op, itemId: first, value: '#ffeeee' }]), [op])).toEqual({ kind: 'apply' });
    expect(check(s, apply(s, [{ ...op, value: '#ffeeee' }]), [op]).kind).toBe('changed');
    expect(check(s, apply(s, [{ type: 'instance.listRemove', owner, nodeId: grid.id, prop: 'items', itemId: second }]), [op])).toEqual({ kind: 'gone', what: 'list item' });
    expect(fieldKey([op])).not.toBe(fieldKey([{ ...op, itemId: undefined }]));
    expect(fieldKey([op])).not.toBe(fieldKey([{ ...op, itemId: first }]));
  });

  it('holds a hover style apart from the resting one and from other states (#348)', () => {
    const s = fresh();
    const home = s.pages[s.site.homePageId];
    const grid = home.rootIds.map((id) => home.nodes[id] as InstanceNode).find((n) => s.components[n.definitionId].componentId === 'features.grid')!;
    const owner = { kind: 'page' as const, id: home.id };
    const op: EditOperation = { type: 'node.setStyle', owner, nodeId: grid.id, partId: 'card', scope: 'base', state: 'hover', property: 'background', value: '#dbeeff' };
    // A change to the resting background is another field; a change to the hover background is this one.
    expect(check(s, apply(s, [{ ...op, state: undefined, value: '#ffeeee' }]), [op])).toEqual({ kind: 'apply' });
    expect(check(s, apply(s, [{ ...op, value: '#ffeeee' }]), [op]).kind).toBe('changed');
    expect(fieldKey([op])).not.toBe(fieldKey([{ ...op, state: 'focus' }]));
    expect(fieldKey([op])).not.toBe(fieldKey([{ ...op, state: undefined }]));
  });

  it('reads the routes for text with a link, a custom style whole, and the project for a font rename', () => {
    const s = fresh();
    const { owner, node, prop, items } = listInstance(s);
    const page = about(s);
    const aiRoute = apply(s, [{ type: 'page.update', pageId: page, route: '/our-team/' }]);
    const linked: EditOperation = { type: 'instance.setProp', owner, nodeId: node.id, prop, itemId: items[0].id, field: 'label', value: 'See [us](/our-team/)' };
    expect(check(aiRoute, s, [linked]).kind).toBe('changed');
    expect(check(aiRoute, s, [{ ...linked, value: 'No link here' }])).toEqual({ kind: 'apply' });
    // Only the pages its links name matter: a link elsewhere ignores the AI's route change.
    expect(check(aiRoute, s, [{ ...linked, value: 'See [our site](https://example.com/) or [contact](/contact/)' }])).toEqual({ kind: 'apply' });

    const custom = { id: 'color.custom-accent', label: 'Accent', group: 'color', value: '#ff0000' } as unknown as ProjectState['tokens']['custom'][number];
    const withCustom = structuredClone(s);
    withCustom.tokens.custom.push(custom);
    const recreated = structuredClone(withCustom);
    recreated.tokens.custom[recreated.tokens.custom.length - 1] = { ...custom, label: 'Highlight' };
    expect(check(recreated, withCustom, [{ type: 'token.set', tokenId: custom.id, value: '#00ff00' }]).kind).toBe('changed');
    expect(check(recreated, withCustom, [{ type: 'token.rename', tokenId: custom.id, label: 'Brand accent' }]).kind).toBe('changed');
    expect(check(withCustom, s, [{ type: 'token.set', tokenId: custom.id, value: '#00ff00' }])).toEqual({ kind: 'gone', what: 'site style' });

    const font = { id: 'a_font1', kind: 'font', name: 'Atlas', file: 'atlas.woff2', font: { family: 'Atlas', weight: '400', style: 'normal' } } as unknown as ProjectState['assets']['assets'][string];
    const withFont = structuredClone(s);
    withFont.assets.assets[font.id] = font;
    const rename: EditOperation = { type: 'asset.update', assetId: font.id, font: { family: 'Atlas Editorial', weight: '400', style: 'normal' } };
    expect(check(withFont, withFont, [rename])).toEqual({ kind: 'apply' });
    // Anything the AI changed anywhere may be a use of the family the rename rewrites.
    const aiElsewhere = apply(withFont, [{ type: 'page.update', pageId: page, description: 'AI words' }]);
    expect(check(aiElsewhere, withFont, [rename]).kind).toBe('changed');
    // Other file details are the file's own.
    expect(check(aiElsewhere, withFont, [{ type: 'asset.update', assetId: font.id, name: 'Atlas regular' }])).toEqual({ kind: 'apply' });
    // Each one its own field: a description written beside a changed suggested alt text is not a conflict (#82).
    const altChanged = structuredClone(withFont);
    (altChanged.assets.assets[font.id] as unknown as Record<string, unknown>).altSuggestion = 'Changed elsewhere';
    expect(check(withFont, altChanged, [{ type: 'asset.update', assetId: font.id, description: 'Typed' }])).toEqual({ kind: 'apply' });
    expect(check(withFont, altChanged, [{ type: 'asset.update', assetId: font.id, altSuggestion: 'Typed' }]).kind).toBe('changed');
  });

  it('holds only field edits: a gesture or a variant rule is not one', () => {
    const s = fresh();
    expect(readFields(s, [{ type: 'page.remove', pageId: about(s) }])).toBeNull();
    expect(readFields(s, [{ type: 'page.update', pageId: about(s), title: 'A' }, { type: 'page.reorder', pageIds: s.site.pageOrder }])).toBeNull();
    expect(readFields(s, [])).toBeNull();
    const { owner, node } = listInstance(s);
    expect(readFields(s, [{ type: 'node.setStyle', owner, nodeId: node.id, variant: 'dark', scope: 'base', property: 'gap', value: null }])).toBeNull();
    expect(readFields(s, [{ type: 'node.setStyle', owner, nodeId: node.id, scope: 'base', property: 'gap', value: null }])).not.toBeNull();
  });

  it('keys a held edit by the fields it writes, not the values', () => {
    const a = fieldKey([{ type: 'page.update', pageId: 'pg_1', seoTitle: 'One' }]);
    expect(fieldKey([{ type: 'page.update', pageId: 'pg_1', seoTitle: 'Two' }])).toBe(a);
    expect(fieldKey([{ type: 'page.update', pageId: 'pg_1', description: 'Two' }])).not.toBe(a);
    expect(fieldKey([{ type: 'page.update', pageId: 'pg_2', seoTitle: 'One' }])).not.toBe(a);
    // Each part of a text style is its own field; a reference replaces the whole style.
    const size = fieldKey([{ type: 'token.set', tokenId: 'text.body', value: { lineHeight: '1.5' } }]);
    expect(fieldKey([{ type: 'token.set', tokenId: 'text.body', value: { lineHeight: '1.6' } }])).toBe(size);
    expect(fieldKey([{ type: 'token.set', tokenId: 'text.body', value: { tracking: '0.01em' } }])).not.toBe(size);
    // An instance style with no part is its root's.
    const owner = { kind: 'page' as const, id: 'pg_1' };
    expect(fieldKey([{ type: 'node.setStyle', owner, nodeId: 'n_1', scope: 'base', property: 'gap', value: null }])).toBe(fieldKey([{ type: 'node.setStyle', owner, nodeId: 'n_1', partId: 'root', scope: 'base', property: 'gap', value: { token: 'space.md' } }]));
    expect(fieldKey([{ type: 'node.setStyle', owner, nodeId: 'n_1', scope: 'base', property: 'gap', value: null }])).not.toBe(fieldKey([{ type: 'node.setStyle', owner, nodeId: 'n_1', scope: 'phone', property: 'gap', value: null }]));
  });

  it('shows the author what they typed and what the field holds now', () => {
    const s = fresh();
    const op: EditOperation = { type: 'page.update', pageId: about(s), seoTitle: 'Mine' };
    expect(typedText(op)).toBe('Mine');
    expect(typedText({ type: 'page.update', pageId: 'x', seoTitle: '' })).toBe('');
    expect(shownField(op, { seoTitle: 'Old' })).toBe('Old');
    expect(shownField(op, { seoTitle: undefined })).toBe('');
    expect(shownField({ type: 'token.set', tokenId: 'color.brand', value: '#fff' }, { themeId: 't', override: '#000' })).toBe('#000');
  });
});

describe('held visitor text (issue #71)', () => {
  const set = (language: string, text: Record<string, string>): EditOperation => ({ type: 'site.update', visitorText: { language, text } });

  it('reads and checks only the piece typed, in its language', () => {
    const base = apply(fresh(), [set('ar', { menu: 'اعرض القائمة' })]);
    const op = set('AR', { menu: 'افتح القائمة' });
    expect(readFields(base, [op])).toEqual([{ found: true, value: { visitorText: 'اعرض القائمة' } }]);
    expect(typedText(op)).toBe('افتح القائمة');
    expect(shownField(op, { visitorText: 'اعرض القائمة' })).toBe('اعرض القائمة');
    // Another piece, or the same piece in another language, changing meanwhile is no conflict.
    expect(check(base, apply(base, [set('ar', { skipLink: 'إلى المحتوى' }), set('he', { menu: 'תפריט' })]), [op])).toEqual({ kind: 'apply' });
    // The piece itself changing is.
    expect(check(base, apply(base, [set('ar', { menu: '' })]), [op])).toEqual({ kind: 'changed', current: [{ visitorText: undefined }] });
    // Several pieces at once are read one by one, and any of them changing is a conflict.
    const both = set('ar', { menu: 'x', skipLink: 'y' });
    expect(readFields(base, [both])).toEqual([{ found: true, value: { visitorText: { menu: 'اعرض القائمة', skipLink: undefined } } }]);
    expect(check(base, apply(base, [set('ar', { skipLink: 'إلى المحتوى' })]), [both]).kind).toBe('changed');
    // Wording kept by hand under another case is read as the editor shows it.
    const hand = structuredClone(base);
    hand.site.visitorText = { AR: { menu: 'يدوي' } };
    expect(readFields(hand, [op])).toEqual([{ found: true, value: { visitorText: 'يدوي' } }]);
    expect(check(base, hand, [op]).kind).toBe('changed');
    // The direction is a field of its own.
    expect(readFields(base, [{ type: 'site.update', direction: 'rtl' }])).toEqual([{ found: true, value: { direction: undefined } }]);
    expect(check(base, apply(base, [{ type: 'site.update', direction: 'ltr' }]), [{ type: 'site.update', direction: 'rtl' }]).kind).toBe('changed');
  });

  it('keeps edits of different pieces apart, and lets a newer edit of the same piece replace an older one', () => {
    expect(fieldKey([set('ar', { menu: 'a' })])).not.toBe(fieldKey([set('ar', { skipLink: 'a' })]));
    expect(fieldKey([set('ar', { menu: 'a' })])).not.toBe(fieldKey([set('he', { menu: 'a' })]));
    expect(fieldKey([set('ar', { menu: 'a' })])).toBe(fieldKey([set('AR', { menu: 'b' })]));
  });
});

describe('held edit row', () => {
  it('offers to stop the AI while it works, and to apply once it has finished', () => {
    expect(heldPrompt({ phase: 'waiting', text: 'x' }, true).actions).toEqual(['stop-apply', 'discard']);
    expect(heldPrompt({ phase: 'waiting', text: 'x' }, false).actions).toEqual(['apply', 'discard']);
    expect(heldPrompt({ phase: 'applying', text: 'x', stopping: true }, true)).toEqual({ message: 'Stopping the AI. Your edit is applied once its changes are undone.', actions: ['discard'] });
    // Once the save is on its way it cannot be called back.
    expect(heldPrompt({ phase: 'applying', text: 'x', writing: true }, true)).toEqual({ message: 'Saving your edit.', actions: [] });
    expect(heldPrompt({ phase: 'waiting', text: 'x', note: 'The AI is working on another request.' }, true).message).toBe('Not saved yet: the AI is working. The AI is working on another request.');
  });

  it('explains a changed field with what it holds now, and a gone target with what can still be done', () => {
    expect(heldPrompt({ phase: 'changed', text: 'Mine', currentText: 'Old' }, false)).toEqual({ message: 'Not applied: this changed while the AI was working and now holds “Old”. Replace it with your edit?', actions: ['replace', 'discard'] });
    expect(heldPrompt({ phase: 'changed', text: 'Mine', currentText: '' }, false).message).toContain('now holds nothing');
    expect(heldPrompt({ phase: 'waiting', text: 'x' }, true, 'asking').message).toBe('Not saved yet: the AI is waiting for your answer.');
    // Stop while it waits: the row follows the toolbar to stopping, never back to working.
    expect(heldPrompt({ phase: 'waiting', text: 'x' }, true, 'stopping').message).toBe('Not saved yet: the AI is stopping.');
    expect(heldPrompt({ phase: 'waiting', text: 'x' }, true).message).toBe('Not saved yet: the AI is working.');
    expect(heldPrompt({ phase: 'gone', text: 'Our people', note: 'page' }, false)).toEqual({
      message: 'Not applied: the page this edit was for no longer exists, so there is nothing to apply it to. Copy your text to use it elsewhere.',
      actions: ['copy', 'discard']
    });
    expect(heldPrompt({ phase: 'gone', text: null, note: 'element' }, false).actions).toEqual(['discard']);
    expect(heldPrompt({ phase: 'failed', text: 'x', note: 'Another page already uses /team/.' }, false)).toEqual({ message: 'Not applied: Another page already uses /team/.', actions: ['retry', 'discard'] });
  });

  it('explains a field changed somewhere else while it was typed, never as the AI’s doing, and offers the typed text (#82)', () => {
    expect(heldPrompt({ phase: 'changed', text: 'Typed', currentText: 'From the file', cause: 'elsewhere' }, false)).toEqual({
      message: 'Not saved: this changed somewhere else while you were typing and now holds “From the file”. Replace it with your edit, or keep it and discard yours?',
      actions: ['replace', 'copy', 'discard']
    });
    expect(heldPrompt({ phase: 'changed', text: null, currentText: 'x', cause: 'elsewhere' }, false).actions).toEqual(['replace', 'discard']);
    expect(heldPrompt({ phase: 'changed', text: 'Typed', currentText: 'x', cause: 'elsewhere' }, true).message).not.toMatch(/AI/);
    expect(heldPrompt({ phase: 'failed', text: 'Typed', note: 'home.json was changed outside SiteOrigin Builder.', cause: 'elsewhere' }, false)).toEqual({
      message: 'Not saved: home.json was changed outside SiteOrigin Builder.',
      actions: ['retry', 'copy', 'discard']
    });
    // A target removed meanwhile reads the same whatever removed it.
    expect(heldPrompt({ phase: 'gone', text: 'Typed', note: 'element', cause: 'elsewhere' }, false).actions).toEqual(['copy', 'discard']);
  });
});

describe('toolbar save state', () => {
  const base = { conflict: false, runStatus: null, stopping: false, handoff: false, held: false, drafting: false, pending: false };

  it('treats stopping the AI for an edit as an AI step, saving it as a save, and a kept edit as its own state', () => {
    expect(settledState({ ...base, runStatus: 'awaiting-input' })).toBe('asking');
    expect(settledState({ ...base, stopping: true, handoff: true })).toBe('stopping');
    expect(settledState({ ...base, handoff: true, pending: true })).toBe('busy');
    expect(settledState({ ...base, handoff: true, held: true })).toBe('busy');
    expect(settledState({ ...base, runStatus: 'running', conflict: true })).toBe('conflict');
    expect(settledState({ ...base, held: true })).toBe('held');
    expect(settledState({ ...base, held: true, conflict: true })).toBe('conflict');
    expect(settledState({ ...base, drafting: true })).toBe('busy');
    expect(settledState({ ...base, pending: true })).toBe('busy');
    expect(settledState(base)).toBe('saved');
  });

  it('tells an AI waiting for the author from one working and one checking its changes', () => {
    for (const r of ['preparing', 'running'] as const) expect(settledState({ ...base, runStatus: r })).toBe('working');
    expect(settledState({ ...base, runStatus: 'awaiting-input' })).toBe('asking');
    for (const r of ['validating', 'repairing'] as const) expect(settledState({ ...base, runStatus: r })).toBe('checking');
    expect(runPhase(null)).toBeNull();
    // Stopping is its own phase, so Stop while a question is open is never heard as a resume.
    expect(runPhase('stopping')).toBe('stopping');
    expect(settledState({ ...base, runStatus: 'stopping' })).toBe('stopping');
    expect(settledState({ ...base, runStatus: 'awaiting-input', stopping: true })).toBe('stopping');
    // A question while the AI is running is not saving: the toolbar says who must act, not "Saving…".
    expect(settledState({ ...base, runStatus: 'awaiting-input', handoff: true })).toBe('asking');
    expect(settledState({ ...base, runStatus: 'running', handoff: true })).toBe('working');
    expect(runPhase('awaiting-input')).toBe('asking');
    expect(settledState({ ...base, runStatus: 'awaiting-input', conflict: true })).toBe('conflict');
    // A failed save leads every other state until a save succeeds again (#753).
    expect(settledState({ ...base, failed: true, conflict: true, runStatus: 'running', pending: true })).toBe('failed');
    expect(settledState({ ...base, failed: false })).toBe('saved');
  });

  it('says who has to act as the AI asks, resumes and checks', () => {
    expect(saveAnnouncement('saved', 'working', null)).toBe('AI is working');
    expect(saveAnnouncement('working', 'asking', null)).toBe('AI is waiting for your answer');
    // Resuming after an answer, or stopping while it waits: the toolbar says the same.
    expect(saveAnnouncement('asking', 'working', null)).toBe('AI is working');
    // A question can come while its changes are being repaired.
    expect(saveAnnouncement('checking', 'asking', null)).toBe('AI is waiting for your answer');
    expect(saveAnnouncement('asking', 'stopping', null)).toBe('AI is stopping. Its changes are being undone');
    expect(saveAnnouncement('stopping', 'saved', { run: 'cancelled' })).toBe('AI stopped');
    expect(saveAnnouncement('working', 'saved', { run: 'no-changes' })).toBe('AI finished without changing anything');
    expect(saveAnnouncement('working', 'checking', null)).toBe('AI is checking its changes');
    expect(saveAnnouncement('asking', 'checking', null)).toBe('AI is checking its changes');
    // A question that ends the request (Stop, or a failure) is announced as how it ended.
    expect(saveAnnouncement('asking', 'saved', { run: 'cancelled' })).toBe('AI stopped');
    expect(saveAnnouncement('checking', 'saved', { run: 'completed' })).toBe('AI changes saved');
    expect(saveAnnouncement('asking', 'held', { run: 'cancelled', edit: 'held' })).toBe('AI stopped. Your edit was not applied. Review it below');
  });

  it('announces a request that ended before it began working, which moved no save state (#83)', () => {
    // Its model could not be reached: the region must not go on saying how the request before it ended.
    expect(unseenRunAnnouncement({ run: 'failed' })).toBe('AI request failed');
    expect(unseenRunAnnouncement({ run: 'cancelled' })).toBe('AI stopped');
    expect(unseenRunAnnouncement({ run: null, edit: 'saved' })).toBeNull();
    expect(unseenRunAnnouncement(null)).toBeNull();

    // Nothing moved but the request ended: said on its own, in place of how the request before it ended.
    expect(toolbarAnnouncement('saved', 'saved', 'saved', true, { run: 'failed' })).toEqual({ say: 'AI request failed', before: 'saved' });
    expect(toolbarAnnouncement('saved', 'saved', 'saved', false, { run: 'failed' }).say).toBeNull();
    // It ended as a save of the author's own finished: both are said.
    expect(toolbarAnnouncement('busy', 'saved', 'saved', true, { run: 'failed' }).say).toBe('AI request failed. All changes saved');
    // A request the toolbar showed at work is said once, as it settles, not again as unseen.
    expect(toolbarAnnouncement('working', 'saved', 'saved', true, { run: 'failed' }).say).toBe('AI request failed');
    expect(toolbarAnnouncement('working', 'busy', 'saved', true, { run: 'failed' })).toEqual({ say: '', before: 'working' });
    expect(toolbarAnnouncement('busy', 'saved', 'working', false, { run: 'failed' }).say).toBe('AI request failed');
    // Ending while a held edit still stops it: said when the stop settles, and only then.
    expect(toolbarAnnouncement('stopping', 'stopping', 'saved', true, { run: 'cancelled' }).say).toBeNull();
    expect(toolbarAnnouncement('asking', 'asking', 'saved', true, { run: 'failed' }).say).toBeNull();
    expect(toolbarAnnouncement('stopping', 'busy', 'saved', false, { run: 'cancelled' })).toEqual({ say: '', before: 'stopping' });
    expect(toolbarAnnouncement('busy', 'saved', 'stopping', false, { run: 'cancelled', edit: 'saved' }).say).toBe('AI stopped. Your edit was saved');
  });

  it('announces how the request really ended, not "AI changes saved" for every ending', () => {
    expect(saveAnnouncement('checking', 'saved', { run: 'cancelled' })).toBe('AI stopped');
    expect(saveAnnouncement('checking', 'saved', { run: 'no-changes' })).toBe('AI finished without changing anything');
    expect(saveAnnouncement('checking', 'saved', { run: 'failed' })).toBe('AI request failed');
    expect(saveAnnouncement('checking', 'saved', { run: 'completed' })).toBe('AI changes saved');
    expect(saveAnnouncement('checking', 'saved', { run: 'cancelled', edit: 'saved' })).toBe('AI stopped. Your edit was saved');
    expect(saveAnnouncement('checking', 'held', { run: 'completed' })).toBe('AI changes saved. Your edit is not saved yet');
    expect(saveAnnouncement('checking', 'held', { run: 'cancelled', edit: 'saved' })).toBe('AI stopped. Your edit was saved. Another edit is not saved yet');
    expect(saveAnnouncement('checking', 'held', { run: null, edit: 'held' })).toBe('Your edit was not applied. Review it below');
    expect(saveAnnouncement('checking', 'saved', { run: 'conflicted' })).toBe('AI stopped. A file changed outside SiteOrigin Builder, so its changes were kept for review');
    expect(saveAnnouncement('saved', 'checking', null)).toBe('AI is checking its changes');
    // "Apply my edit" after the AI had finished: a save of the author's edit, not an AI check.
    expect(saveAnnouncement('held', 'saved', { run: null, edit: 'saved' })).toBe('Your edit was saved');
    expect(saveAnnouncement('held', 'saved', { run: 'completed' })).toBe('All changes saved');
    expect(saveAnnouncement('busy', 'saved', { run: 'cancelled' })).toBe('All changes saved');
    expect(saveAnnouncement('conflict', 'saved', null)).toBe('File conflict resolved. All changes saved');
    expect(saveAnnouncement('saved', 'busy', null)).toBe('');
  });
});

describe('held custom field values (#675)', () => {
  const team = () =>
    apply(fresh(), [
      { type: 'collection.create', collectionId: 'team', kind: 'structured', hasBody: false, pages: { detail: false, archive: false }, fields: { role: { type: 'string', label: 'Role', default: '' }, department: { type: 'string', label: 'Department', default: '' } } },
      { type: 'entry.create', collectionId: 'team', entryId: 'en_ana1', title: 'Ana', values: { role: 'Potter' } }
    ]);
  const set = (values: Record<string, unknown>): EditOperation => ({ type: 'entry.update', collectionId: 'team', entryId: 'en_ana1', values });

  it('keeps each field its own: a held role is replaced by a newer role, never by a department', () => {
    expect(fieldKey([set({ role: 'Glazer' })])).toBe(fieldKey([set({ role: 'Kiln lead' })]));
    expect(fieldKey([set({ role: 'Glazer' })])).not.toBe(fieldKey([set({ department: 'Studio' })]));
  });

  it('applies a held role over a department changed meanwhile, and stops on the role changed or its field removed', () => {
    const base = team();
    const op = set({ role: 'Glazer' });
    expect(check(base, apply(base, [set({ department: 'Studio' })]), [op]).kind).toBe('apply');
    expect(check(base, apply(base, [set({ role: 'Kiln lead' })]), [op]).kind).toBe('changed');
    const retyped = apply(base, [{ type: 'collection.update', collectionId: 'team', fields: { role: { type: 'string', label: 'Role', default: 'Maker' }, department: { type: 'string', label: 'Department', default: '' } } }]);
    expect(check(base, retyped, [op]).kind).toBe('changed');
  });

  it('shows the value typed and the value held as text', () => {
    const base = team();
    const op = set({ role: 'Glazer' });
    expect(typedText(op)).toBe('Glazer');
    const read = readFields(base, [op])![0];
    expect(read.found && shownField(op, read.value)).toBe('Potter');
  });
});
