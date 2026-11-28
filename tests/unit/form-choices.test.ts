/**
 * Single-choice questions and checkboxes in the contact form (issue #238): each choice keeps the value it is sent
 * as while its label changes, the editor shows a field only the settings its type uses, a question with nothing to
 * choose from is reported, and forms from before choices existed keep working and can take the update.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChoiceOption, ComponentDefinition, InstanceNode, ListItem, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { definitionHash } from '@shared/migrations';
import { createStarterState } from '@catalogue/starters';
import { getTheme } from '@catalogue/index';
import { formFieldKey, formFieldSettingsHidden, formRefusesUnchoosable, formUnchoosable, offersFormChoices } from '@shared/form-contract';
import { installComponent, makeInstance } from '@engine/install';
import { applyOperations } from '@engine/apply';
import { themeUpdates } from '@engine/theme-updates';
import { validateState } from '@engine/validate';
import { MAX_CHOICES, normalizeChoices } from '@engine/values';
import { EngineError } from '@engine/tree';
import { generateProject } from '@generator/index';
import { renderedContent } from '@generator/checks';
import { applyChoiceAction, staleRename } from '../../src/renderer/src/lib/choices';

/** Foundation's contact form as the app loads it. */
const contactForm = getTheme('foundation').components.find((c) => c.componentId === 'contact.form')!;
const LEGACY: ComponentDefinition = JSON.parse(readFileSync(join(__dirname, 'fixtures/v1-project/siteorigin/components/foundation.contact.form/component.json'), 'utf8'));

const home = (s: ProjectState) => s.pages[s.site.homePageId];
const owner = (s: ProjectState) => ({ kind: 'page' as const, id: s.site.homePageId });

/** A project with one contact form on Home, optionally with its own fields or another definition, locked as installed. */
function withForm(fields?: Array<Record<string, unknown>>, def?: ComponentDefinition) {
  const s = createStarterState('business', 'Test Studio', false);
  const id = installComponent(s, 'contact.form');
  if (def) {
    s.components[id] = { ...structuredClone(def), id };
    s.themeLock.components[id] = { ...s.themeLock.components[id], hash: definitionHash(s.components[id]) };
  }
  const node = makeInstance(s.components[id], { provider: 'netlify' });
  if (fields) node.props.fields = structuredClone(fields);
  home(s).nodes[node.id] = node;
  home(s).rootIds.push(node.id);
  return { s, nodeId: node.id, defId: id };
}

const fieldsOf = (s: ProjectState, nodeId: string) => (home(s).nodes[nodeId] as InstanceNode).props.fields as ListItem[];
const fieldNamed = (s: ProjectState, nodeId: string, label: string) => fieldsOf(s, nodeId).find((f) => f.label === label)!;
const choicesOf = (s: ProjectState, nodeId: string, label: string) => fieldNamed(s, nodeId, label).options as ChoiceOption[];
const pairs = (choices: ChoiceOption[]) => choices.map((c) => [c.label, c.value]);

function edit(s: ProjectState, nodeId: string, ...ops: Array<Record<string, unknown>>): ProjectState {
  return applyOperations(s, ops.map((op) => ({ owner: owner(s), nodeId, prop: 'fields', ...op }) as EditOperation)).state;
}

const rejects = (fn: () => unknown, msg: RegExp) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(EngineError);
    expect((e as Error).message).toMatch(msg);
    return;
  }
  throw new Error('expected the edit to be refused');
};

const SERVICE = 'Which service are you interested in?';

describe('a choice keeps the value it is sent as', () => {
  it('sends a new choice as its label, and keeps that value through a rename, a move and a translation', () => {
    const made = normalizeChoices(['Kitchen', ' Lighting ', 'Other'], 'Choices');
    expect(pairs(made)).toEqual([
      ['Kitchen', 'Kitchen'],
      ['Lighting', 'Lighting'],
      ['Other', 'Other']
    ]);
    expect(new Set(made.map((c) => c.id)).size).toBe(3);
    const [kitchen, lighting, other] = made;
    // Renamed, translated and moved to the top, by id: earlier answers to it were sent as "Lighting", and still are.
    const moved = normalizeChoices([{ ...lighting, label: 'Éclairage' }, kitchen, other], 'Choices', made);
    expect(moved.map((c) => [c.id, c.label, c.value])).toEqual([
      [lighting.id, 'Éclairage', 'Lighting'],
      [kitchen.id, 'Kitchen', 'Kitchen'],
      [other.id, 'Other', 'Other']
    ]);
    // A new choice called what the old one was called is another answer, sent as something else, wherever it goes.
    for (const order of [(n: Record<string, unknown>) => [n, ...moved], (n: Record<string, unknown>) => [...moved, n]]) {
      const added = normalizeChoices(order({ label: 'Lighting' }), 'Choices', moved);
      expect(added.find((c) => c.label === 'Lighting')!.value).toBe('Lighting (2)');
      expect(added.find((c) => c.id === lighting.id)!.value).toBe('Lighting');
    }
  });

  it('reads a set rewritten as labels as the saved choices still offered under them', () => {
    const saved = normalizeChoices(['Kitchen', 'Lighting', 'Other'], 'Choices');
    const renamed = normalizeChoices(saved.map((c) => (c.label === 'Lighting' ? { ...c, label: 'Éclairage' } : c)), 'Choices', saved);
    // The agent re-sends the labels it read, plus one: every kept choice keeps its id and value.
    const next = normalizeChoices(['kitchen', 'Éclairage', 'Other', 'Bathrooms'], 'Choices', renamed);
    expect(next.map((c) => [c.id, c.label, c.value])).toEqual([
      [saved[0].id, 'kitchen', 'Kitchen'],
      [saved[1].id, 'Éclairage', 'Lighting'],
      [saved[2].id, 'Other', 'Other'],
      [expect.any(String), 'Bathrooms', 'Bathrooms']
    ]);
    expect(saved.map((c) => c.id)).not.toContain(next[3].id);
    // Or moves them, still by label.
    expect(normalizeChoices(['Other', 'Éclairage', 'kitchen'], 'Choices', renamed).map((c) => [c.id, c.value])).toEqual([
      [saved[2].id, 'Other'],
      [saved[1].id, 'Lighting'],
      [saved[0].id, 'Kitchen']
    ]);
  });

  it('refuses an edit that would quietly change what an answer is sent as', () => {
    const saved = normalizeChoices(['Kitchen', 'Lighting'], 'Choices');
    // Labels alone cannot say whether "Éclairage" renames "Lighting" or replaces it.
    rejects(() => normalizeChoices(['Kitchen', 'Éclairage'], 'Choices', saved), /“Éclairage” is new and “Lighting” is no longer offered\. To rename a choice, send it with its id/);
    rejects(() => normalizeChoices([saved[0], { ...saved[1], value: 'Lights' }], 'Choices', saved), /“Lighting” is sent as “Lighting”, which cannot change/);
    rejects(() => normalizeChoices([saved[0], { label: 'Lighting', value: 'Lights' }], 'Choices', saved), /cannot change/);
    // Of "Starter" and "Basic", ["Basic"] may keep either one (Starter renamed after Basic went), so a removal
    // needs the ids of the choices kept.
    const plans = normalizeChoices(['Starter', 'Basic'], 'Choices');
    rejects(() => normalizeChoices(['Basic'], 'Choices', plans), /“Starter” is no longer offered and “Basic” was sent without its id\. To remove a choice, send the ones you keep with their ids/);
    expect(pairs(normalizeChoices([plans[1]], 'Choices', plans))).toEqual([['Basic', 'Basic']]);
    expect(pairs(normalizeChoices([{ ...plans[0], label: 'Basic' }], 'Choices', plans))).toEqual([['Basic', 'Starter']]);
    // Removing one and adding another in separate edits replaces it.
    const removed = normalizeChoices([saved[0]], 'Choices', saved);
    expect(pairs(normalizeChoices([...removed, { label: 'Éclairage' }], 'Choices', removed))).toEqual([
      ['Kitchen', 'Kitchen'],
      ['Éclairage', 'Éclairage']
    ]);
  });

  it('refuses choices a visitor could not tell apart or could not read', () => {
    rejects(() => normalizeChoices(['Kitchen', ' kitchen '], 'Choices'), /“kitchen” is offered twice/);
    rejects(() => normalizeChoices(['Kitchen', '  '], 'Choices'), /choice 2 needs a label/);
    rejects(() => normalizeChoices([{ label: 'Kitchen' }, { id: 'x' }], 'Choices'), /choice 2 needs a label/);
    rejects(() => normalizeChoices('Kitchen, Lighting', 'Choices'), /expected a list of choices/);
    rejects(() => normalizeChoices([['Kitchen']], 'Choices'), /choice 1 should be its label/);
    expect(normalizeChoices(Array.from({ length: MAX_CHOICES }, (_, i) => `Choice ${i}`), 'Choices')).toHaveLength(MAX_CHOICES);
    rejects(() => normalizeChoices(Array.from({ length: MAX_CHOICES + 1 }, (_, i) => `Choice ${i}`), 'Choices'), new RegExp(`at most ${MAX_CHOICES} choices`));
    rejects(() => normalizeChoices(['x'.repeat(201)], 'Choices'), /longer than 200 characters/);
    rejects(() => normalizeChoices([{ label: 'Kitchen', value: 'x'.repeat(201) }], 'Choices'), /“Kitchen” has a value longer than 200 characters/);
  });

  it('keeps a copied set’s ids and values, but never two choices with one id or one value', () => {
    const copied = normalizeChoices(
      [
        { id: 'c_kitchen', label: 'Kitchen', value: 'kitchen-works' },
        { id: 'not an id!', label: 'Lighting' }
      ],
      'Choices'
    );
    expect(copied.map((c) => [c.label, c.value])).toEqual([
      ['Kitchen', 'kitchen-works'],
      ['Lighting', 'Lighting']
    ]);
    expect(copied[0].id).toBe('c_kitchen');
    expect(copied[1].id).toMatch(/^c_[a-z0-9]{8}$/);
    rejects(() => normalizeChoices([{ id: 'a', label: 'Kitchen' }, { id: 'a', label: 'Lighting' }], 'Choices', [{ id: 'a', label: 'Kitchen', value: 'Kitchen' }]), /two choices share the id "a"/);
    const values = normalizeChoices([{ label: 'Kitchen', value: 'Other' }, { label: 'other' }, { label: 'Else', value: 'OTHER' }], 'Choices').map((c) => c.value);
    expect(values).toEqual(['Other', 'other (2)', 'OTHER (3)']);
  });

  it('numbers a long value within the length a value may have, so the choice can still be sent back as it is', () => {
    const long = 'x'.repeat(200);
    const first = normalizeChoices([long], 'Choices');
    const renamed = normalizeChoices([{ ...first[0], label: 'Other' }], 'Choices', first);
    const again = normalizeChoices([...renamed, long], 'Choices', renamed);
    expect(again[1].value).toBe(`${'x'.repeat(196)} (2)`);
    // Moved, by id, with every value as it was saved.
    expect(normalizeChoices([again[1], again[0]], 'Choices', again).map((c) => c.value)).toEqual([again[1].value, long]);
    // Never half of a character that takes two units.
    const emoji = `${'x'.repeat(195)}😀`;
    const first2 = normalizeChoices([emoji], 'Choices');
    const numbered = normalizeChoices([{ ...first2[0], label: 'Other' }, emoji], 'Choices', first2)[1].value;
    expect(numbered).toBe(`${'x'.repeat(195)} (2)`);
    expect(numbered.length).toBeLessThanOrEqual(200);
  });

  it('keeps a set saved under older rules while it is not being changed', () => {
    const legacy = [
      { id: 'a', label: 'Kitchen', value: 'Kitchen' },
      { id: 'b', label: 'kitchen', value: 'Kitchen 2' }
    ];
    expect(normalizeChoices(structuredClone(legacy), 'Choices', legacy)).toEqual(legacy);
  });
});

describe('editing a form’s questions', () => {
  it('adds a required single-choice question and a checkbox, and keeps each key and choice value through edits', () => {
    const { s, nodeId } = withForm();
    let next = edit(
      s,
      nodeId,
      { type: 'instance.listInsert', item: { label: SERVICE, type: 'choice', required: true, options: ['Kitchen', 'Lighting', 'Other'] } },
      { type: 'instance.listInsert', item: { label: 'Send me a copy', type: 'checkbox' } }
    );
    const service = fieldNamed(next, nodeId, SERVICE);
    expect(service.name).toBe('which-service-are-you-interested-in');
    expect(service).toMatchObject({ type: 'choice', required: true });
    expect(fieldNamed(next, nodeId, 'Send me a copy')).toMatchObject({ name: 'send-me-a-copy', type: 'checkbox', required: false, options: [] });
    const [kitchen, lighting, other] = choicesOf(next, nodeId, SERVICE);
    // The inspector sends the whole set, by id, for a rename, a move or a removal.
    next = edit(next, nodeId, { type: 'instance.setProp', itemId: service.id, field: 'options', value: [{ ...lighting, label: 'Éclairage' }, kitchen, other] });
    next = edit(next, nodeId, { type: 'instance.setProp', itemId: service.id, field: 'label', value: 'Service' });
    expect(fieldNamed(next, nodeId, 'Service').name).toBe('which-service-are-you-interested-in');
    expect(pairs(choicesOf(next, nodeId, 'Service'))).toEqual([
      ['Éclairage', 'Lighting'],
      ['Kitchen', 'Kitchen'],
      ['Other', 'Other']
    ]);
    // Switching to text and back hides the choices and brings them back, untouched.
    next = edit(next, nodeId, { type: 'instance.setProp', itemId: service.id, field: 'type', value: 'text' }, { type: 'instance.setProp', itemId: service.id, field: 'type', value: 'choice' });
    expect(pairs(choicesOf(next, nodeId, 'Service'))[0]).toEqual(['Éclairage', 'Lighting']);
    expect(validateState(next).filter((d) => d.code.startsWith('FORM_') && d.code !== 'FORM_UNCONNECTED')).toEqual([]);
  });

  it('keeps a question’s choices when the agent rewrites the fields without them, and clears them only when told', () => {
    const { s, nodeId } = withForm();
    let next = edit(s, nodeId, { type: 'instance.listInsert', item: { label: SERVICE, type: 'choice', options: ['Kitchen', 'Lighting'] } });
    const before = choicesOf(next, nodeId, SERVICE);
    const id = fieldNamed(next, nodeId, SERVICE).id;
    const rewrite = (options?: unknown) =>
      fieldsOf(next, nodeId).map(({ options: _drop, ...f }) => (f.id === id ? { ...f, label: 'Service', ...(options === undefined ? {} : { options }) } : f));
    next = edit(next, nodeId, { type: 'instance.setProp', value: rewrite() });
    expect(choicesOf(next, nodeId, 'Service')).toEqual(before);
    next = edit(next, nodeId, { type: 'instance.setProp', value: rewrite([]) });
    expect(choicesOf(next, nodeId, 'Service')).toEqual([]);
  });

  it('warns about a single-choice question with nothing to choose from, and says the form will not send', () => {
    const { s, nodeId } = withForm();
    const next = edit(s, nodeId, { type: 'instance.listInsert', item: { label: SERVICE, type: 'choice', required: true } });
    expect(validateState(next).filter((d) => d.code === 'FORM_NO_CHOICES').map((d) => d.message)).toEqual([
      expect.stringContaining(`the contact form's “${SERVICE}” field has no choices to pick from, so visitors cannot send the form. Add its choices, or change its type.`)
    ]);
    expect(formUnchoosable([{ type: 'choice', options: [{ id: 'a', label: '  ', value: 'x' }] }, { type: 'choice', options: [{ id: 'b', label: 'Yes', value: 'Yes' }] }, { type: 'text' }])).toEqual([0]);
    expect(formRefusesUnchoosable(contactForm)).toBe(true);
  });

  it('leaves a placeholder its field’s type never shows out of the page’s words, so Find and Replace cannot reach it', () => {
    const { s, nodeId } = withForm([{ id: 'f1', label: 'Copy', name: 'copy', type: 'text', required: false, placeholder: 'Zanzibar quill' }]);
    const found = (state: ProjectState) => renderedContent(state, home(state)).filter((c) => c.value === 'Zanzibar quill');
    expect(found(s).map((c) => c.source)).toEqual([{ kind: 'prop', prop: 'fields', itemId: 'f1', field: 'placeholder' }]);
    for (const type of ['checkbox', 'choice']) expect(found(edit(s, nodeId, { type: 'instance.setProp', itemId: 'f1', field: 'type', value: type }))).toEqual([]);
  });

  it('shows each type of field only the settings it uses, and offers the new types only where the form renders them', () => {
    expect(formFieldSettingsHidden({ type: 'choice' })).toEqual(['placeholder', 'value']);
    // A dropdown's placeholder is what it shows until an answer is picked (issue #1337).
    expect(formFieldSettingsHidden({ type: 'select' })).toEqual(['value']);
    for (const type of ['checkbox', 'date', 'time']) expect(formFieldSettingsHidden({ type })).toEqual(['placeholder', 'options', 'value']);
    // A hidden field sends its value, and there is nothing for a visitor to fill in or leave out.
    expect(formFieldSettingsHidden({ type: 'hidden' })).toEqual(['placeholder', 'options', 'required']);
    for (const type of ['text', 'email', 'tel', 'textarea', undefined]) expect(formFieldSettingsHidden({ type })).toEqual(['options', 'value']);
    expect(offersFormChoices(contactForm)).toBe(true);
    expect(offersFormChoices(LEGACY)).toBe(false);
    // A copy whose code no longer names fields the theme's way is custom code: its fields are its own business.
    expect(offersFormChoices({ ...contactForm, source: contactForm.source!.replace("'subject', ", '') })).toBe(false);
  });

  it('offers dropdowns, dates, times and hidden fields on both forms, a hidden field with a value of its own (issue #1337)', () => {
    for (const componentId of ['contact.form', 'block.signup']) {
      const def = getTheme('foundation').components.find((c) => c.componentId === componentId)!;
      const fields = def.properties.fields;
      if (fields?.type !== 'list') throw new Error(`${componentId} has no fields list`);
      const type = fields.fields.type;
      expect(type?.type === 'enum' && type.options.map((o) => o.value)).toEqual(['text', 'email', 'tel', 'textarea', 'date', 'time', 'choice', 'select', 'checkbox', 'hidden']);
      expect(fields.fields.value).toMatchObject({ type: 'string', default: '' });
      expect(offersFormChoices(def)).toBe(true);
      expect(formRefusesUnchoosable(def)).toBe(true);
    }
  });

  it('adds a dropdown and a hidden field, keeping the dropdown’s choices and the hidden value through a switch of type (issue #1337)', () => {
    const { s, nodeId } = withForm();
    let next = edit(
      s,
      nodeId,
      { type: 'instance.listInsert', item: { label: 'Suite', type: 'select', required: true, options: ['Garden suite', 'Harbour suite'] } },
      { type: 'instance.listInsert', item: { label: 'Listing', type: 'hidden', value: 'Oak House' } }
    );
    const suite = fieldNamed(next, nodeId, 'Suite');
    expect(suite).toMatchObject({ name: 'suite', type: 'select', required: true });
    expect(pairs(choicesOf(next, nodeId, 'Suite'))).toEqual([
      ['Garden suite', 'Garden suite'],
      ['Harbour suite', 'Harbour suite']
    ]);
    const listing = fieldNamed(next, nodeId, 'Listing');
    expect(listing).toMatchObject({ name: 'listing', type: 'hidden', value: 'Oak House' });
    // A dropdown and radio buttons ask the same question: switching keeps the choices and what each is sent as.
    next = edit(next, nodeId, { type: 'instance.setProp', itemId: suite.id, field: 'type', value: 'choice' }, { type: 'instance.setProp', itemId: suite.id, field: 'type', value: 'select' });
    expect(pairs(choicesOf(next, nodeId, 'Suite'))).toEqual([
      ['Garden suite', 'Garden suite'],
      ['Harbour suite', 'Harbour suite']
    ]);
    next = edit(next, nodeId, { type: 'instance.setProp', itemId: listing.id, field: 'type', value: 'text' }, { type: 'instance.setProp', itemId: listing.id, field: 'type', value: 'hidden' });
    expect(fieldNamed(next, nodeId, 'Listing').value).toBe('Oak House');
    expect(validateState(next).filter((d) => d.code === 'FORM_NO_CHOICES' || d.code === 'FORM_FIELD_KEYS')).toEqual([]);
  });

  it('warns about a dropdown with nothing to choose from, and says the form will not send (issue #1337)', () => {
    const { s, nodeId } = withForm();
    const next = edit(s, nodeId, { type: 'instance.listInsert', item: { label: 'Suite', type: 'select' } });
    expect(validateState(next).filter((d) => d.code === 'FORM_NO_CHOICES').map((d) => d.message)).toEqual([
      expect.stringContaining('the contact form\'s “Suite” field has no choices to pick from, so visitors cannot send the form. Add its choices, or change its type.')
    ]);
    expect(formUnchoosable([{ type: 'select', options: [{ id: 'a', label: '  ', value: 'x' }] }, { type: 'select', options: [{ id: 'b', label: 'Yes', value: 'Yes' }] }, { type: 'hidden' }])).toEqual([0]);
  });

  it('leaves a hidden field’s label and value out of the page’s words, and a dropdown’s placeholder in them (issue #1337)', () => {
    const { s, nodeId } = withForm([
      { id: 'f1', label: 'Zanzibar quill', name: 'listing', type: 'hidden', required: false, placeholder: '', value: 'Quokka lantern' },
      { id: 'f2', label: 'Suite', name: 'suite', type: 'select', required: false, placeholder: 'Marmalade prompt', options: [{ id: 'o1', label: 'Garden', value: 'Garden' }] }
    ]);
    const words = renderedContent(s, home(s)).filter((c) => c.source?.kind === 'prop' && c.source.prop === 'fields');
    expect(words.map((c) => c.value)).not.toContain('Zanzibar quill');
    expect(words.map((c) => c.value)).not.toContain('Quokka lantern');
    expect(words.find((c) => c.value === 'Marmalade prompt')?.source).toEqual({ kind: 'prop', prop: 'fields', itemId: 'f2', field: 'placeholder' });
    // Shown as a text field, its label is on the page again.
    const shown = edit(s, nodeId, { type: 'instance.setProp', itemId: 'f1', field: 'type', value: 'text' });
    expect(renderedContent(shown, home(shown)).map((c) => c.value)).toContain('Zanzibar quill');
  });
});

describe('forms from before choices', () => {
  const OLD_FIELDS = [
    { id: 'item-1', label: 'Name', name: 'name', type: 'text', required: true, placeholder: '' },
    { id: 'item-2', label: 'Message', name: 'message', type: 'textarea', required: true, placeholder: '' }
  ];

  it('keep working as they are, and take the update with their fields unchanged', () => {
    const { s, nodeId, defId } = withForm(OLD_FIELDS, LEGACY);
    expect(LEGACY.properties.fields.type === 'list' && 'options' in LEGACY.properties.fields.fields).toBe(false);
    // The older form offers neither new type, and nothing about it is reported.
    rejects(() => edit(s, nodeId, { type: 'instance.setProp', itemId: 'item-1', field: 'type', value: 'choice' }), /must be one of text, email, tel, textarea/);
    expect(validateState(s).filter((d) => d.code === 'FORM_NO_CHOICES')).toEqual([]);
    expect(generateProject(s).size).toBeGreaterThan(0);

    expect(themeUpdates(s).available.map((u) => u.id)).toContain(defId);
    const pages = JSON.stringify(s.pages);
    const { state: next } = applyOperations(s, [{ type: 'theme.refresh', definitionIds: [defId] }]);
    expect(next.components[defId].source).toBe(contactForm.source);
    expect(JSON.stringify(next.pages)).toBe(pages);
    // Exported before anything else is edited: a stored field without choices is sent without them.
    const page = generateProject(next).get('src/routes/+page.svelte')!;
    const fields = JSON.parse(/^\tfields=\{(.*)\}$/m.exec(page)![1]) as Array<Record<string, unknown>>;
    expect(fields.map((f) => [f.name, f.type, f.options])).toEqual([
      ['name', 'text', []],
      ['message', 'textarea', []]
    ]);
    expect(fields.map((f, i) => formFieldKey(f, i))).toEqual(['name', 'message']);
    // Now its fields can ask a question.
    const asked = edit(next, nodeId, { type: 'instance.setProp', itemId: 'item-1', field: 'type', value: 'choice' }, { type: 'instance.setProp', itemId: 'item-1', field: 'options', value: ['Mr', 'Ms'] });
    expect(pairs(choicesOf(asked, nodeId, 'Name'))).toEqual([
      ['Mr', 'Mr'],
      ['Ms', 'Ms']
    ]);
  });
});

describe('the inspector’s changes to a set of choices', () => {
  const saved = normalizeChoices(['Kitchen', 'Lighting', 'Other'], 'Choices');
  const [kitchen, lighting, other] = saved;

  it('names each choice by id and applies to the set as the project holds it', () => {
    expect(applyChoiceAction(saved, { kind: 'add', label: '  Bath   rooms ' })).toEqual([...saved, { label: 'Bath rooms' }]);
    expect(applyChoiceAction(saved, { kind: 'rename', id: lighting.id, label: 'Éclairage' })).toEqual([kitchen, { ...lighting, label: 'Éclairage' }, other]);
    expect(applyChoiceAction(saved, { kind: 'move', id: lighting.id, by: -1 })).toEqual([lighting, kitchen, other]);
    expect(applyChoiceAction(saved, { kind: 'move', id: lighting.id, by: 1 })).toEqual([kitchen, other, lighting]);
    expect(applyChoiceAction(saved, { kind: 'remove', id: kitchen.id })).toEqual([lighting, other]);
    // A rename made first and a move made right after it, each applied to what the one before it made.
    const renamed = normalizeChoices(applyChoiceAction(saved, { kind: 'rename', id: lighting.id, label: 'Éclairage' })!, 'Choices', saved);
    expect(pairs(normalizeChoices(applyChoiceAction(renamed, { kind: 'move', id: lighting.id, by: -1 })!, 'Choices', renamed))).toEqual([
      ['Éclairage', 'Lighting'],
      ['Kitchen', 'Kitchen'],
      ['Other', 'Other']
    ]);
  });

  it('refuses a rename typed over a label the choice no longer has, and applies one typed over its own', () => {
    const renamedByAi = saved.map((c) => (c.id === kitchen.id ? { ...c, label: 'Cuisine' } : c));
    expect(staleRename(renamedByAi, { kind: 'rename', id: kitchen.id, label: 'Bath', from: ['Kitchen'] })).toMatchObject({ label: 'Cuisine' });
    expect(applyChoiceAction(renamedByAi, { kind: 'rename', id: kitchen.id, label: 'Bath', from: ['Kitchen'] })).toBeNull();
    expect(applyChoiceAction(renamedByAi, { kind: 'rename', id: kitchen.id, label: 'Bath', from: ['Cuisine'] })).toEqual([{ ...kitchen, label: 'Bath' }, lighting, other]);
    // A second rename typed over the first, which has landed meanwhile: back to the label it started with.
    const bath = saved.map((c) => (c.id === kitchen.id ? { ...c, label: 'Bath' } : c));
    expect(applyChoiceAction(bath, { kind: 'rename', id: kitchen.id, label: 'Kitchen', from: ['Kitchen', 'Bath'] })).toEqual(saved);
    // Typed over a rename the project then refused (a label already offered): the choice still has its saved label.
    expect(applyChoiceAction(saved, { kind: 'rename', id: kitchen.id, label: 'Bath', from: ['Kitchen', 'Lighting'] })).toEqual(bath);
    expect(staleRename(saved, { kind: 'move', id: kitchen.id, by: 1 })).toBeUndefined();
  });

  it('does nothing that changes nothing, or that names a choice no longer there', () => {
    expect(applyChoiceAction(saved, { kind: 'add', label: 'kitchen' })).toBeNull();
    expect(applyChoiceAction(saved, { kind: 'add', label: '   ' })).toBeNull();
    expect(applyChoiceAction(saved, { kind: 'rename', id: kitchen.id, label: ' Kitchen ' })).toBeNull();
    expect(applyChoiceAction(saved, { kind: 'rename', id: kitchen.id, label: '' })).toBeNull();
    expect(applyChoiceAction(saved, { kind: 'move', id: kitchen.id, by: -1 })).toBeNull();
    expect(applyChoiceAction(saved, { kind: 'move', id: other.id, by: 1 })).toBeNull();
    for (const action of [{ kind: 'rename', id: 'gone', label: 'X' }, { kind: 'move', id: 'gone', by: 1 }, { kind: 'remove', id: 'gone' }] as const) expect(applyChoiceAction(saved, action)).toBeNull();
  });
});
