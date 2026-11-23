/**
 * Contact form submission keys (issue #198): the key each field's answer is sent under stays distinct and stable
 * while the form is edited, the editor's idea of a key is exactly the exported component's, and a form whose
 * fields share a key says so instead of sending answers nobody can tell apart.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { compile } from 'svelte/compiler';
import { render } from 'svelte/server';
import type { Component } from 'svelte';
import type { ComponentDefinition, InstanceNode, ListItem, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { contactForm, formFieldKey, formKeyClashes, formKeyNote, namesFormFields, formRefusesClashes } from '@catalogue/foundation/form';
import { installComponent, makeInstance } from '@engine/install';
import { applyOperations } from '@engine/apply';
import { validateState } from '@engine/validate';
import { generateProject } from '@generator/index';
import { ProjectSession } from '../../src/main/project/session';

const LEGACY: ComponentDefinition = JSON.parse(readFileSync(join(__dirname, 'fixtures/v1-project/siteorigin/components/foundation.contact.form/component.json'), 'utf8'));

const fresh = () => createStarterState('business', 'Test Studio', false);
const home = (s: ProjectState) => s.pages[s.site.homePageId];
const owner = (s: ProjectState) => ({ kind: 'page' as const, id: s.site.homePageId });

/** A project with one contact form on Home, optionally with its own fields or another definition. */
function withForm(fields?: Array<Record<string, unknown>>, def?: ComponentDefinition) {
  const s = fresh();
  const id = installComponent(s, 'contact.form');
  if (def) s.components[id] = { ...structuredClone(def), id };
  const node = makeInstance(s.components[id], {});
  // As a stored document holds them, item IDs included.
  if (fields) node.props.fields = structuredClone(fields);
  home(s).nodes[node.id] = node;
  home(s).rootIds.push(node.id);
  return { s, nodeId: node.id };
}

const fieldsOf = (s: ProjectState, nodeId: string) => (home(s).nodes[nodeId] as InstanceNode).props.fields as ListItem[];
/** Item ID → the key its answer is sent under. */
const keysOf = (s: ProjectState, nodeId: string) => Object.fromEntries(fieldsOf(s, nodeId).map((f, i) => [f.id, formFieldKey(f, i)]));
const idOf = (s: ProjectState, nodeId: string, label: string) => fieldsOf(s, nodeId).find((f) => f.label === label)!.id;
const clashWarnings = (s: ProjectState) => validateState(s).filter((d) => d.code === 'FORM_FIELD_KEYS');

function edit(s: ProjectState, nodeId: string, ...ops: Array<Record<string, unknown>>): ProjectState {
  return applyOperations(s, ops.map((op) => ({ owner: owner(s), nodeId, prop: 'fields', ...op }) as EditOperation)).state;
}

describe('which forms the editor reads keys for', () => {
  it('recognises the theme form in this version and the one projects already hold, and nothing else', () => {
    expect(namesFormFields(contactForm)).toBe(true);
    expect(namesFormFields(LEGACY)).toBe(true);
    expect(formRefusesClashes(contactForm)).toBe(true);
    expect(formRefusesClashes(LEGACY)).toBe(false);
    // Custom code that names fields some other way gets no inferred keys.
    const custom = { ...contactForm, source: contactForm.source!.replace("'subject', ", '') };
    expect(namesFormFields(custom)).toBe(false);
  });
});

describe('the editor computes the keys the exported form sends', () => {
  let dir: string;
  const forms: Record<string, Component<Record<string, unknown>>> = {};

  beforeAll(async () => {
    mkdirSync(resolve('.tmp'), { recursive: true });
    dir = mkdtempSync(join(resolve('.tmp'), 'form-keys-'));
    for (const [name, def] of [['current', contactForm], ['legacy', LEGACY]] as const) {
      writeFileSync(join(dir, `${name}.js`), compile(def.source!, { filename: `${name}.svelte`, generate: 'server', runes: true }).js.code);
      forms[name] = (await import(/* @vite-ignore */ join(dir, `${name}.js`))).default;
    }
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** The names of the visible fields, as rendered: no hidden inputs and no honeypot. */
  const rendered = (form: string, fields: Array<Record<string, unknown>>) => {
    const html = render(forms[form], { props: { provider: 'netlify', formName: 'contact', fields } }).body;
    const names = [...html.matchAll(/<(?:input|textarea)\b[^>]*>/g)].map((m) => m[0]).filter((t) => !/type="hidden"|tabindex="-1"/.test(t));
    return { html, names: names.map((t) => /name="([^"]*)"/.exec(t)?.[1]) };
  };

  const VECTORS: Array<Array<Record<string, unknown>>> = [
    [
      { label: 'Name', name: 'name' },
      { label: 'Email', name: 'EMAIL' },
      { label: '電話', name: '' },
      { label: '', name: '' },
      { label: 'Subject', name: '' },
      { label: 'Odd', name: '!!!' },
      { label: 'Téléphone', name: '' },
      { label: 'First Name', name: '' },
      { label: 'Spaces', name: '   ' },
      { label: 'Trap', name: 'bot-field' },
      { label: 'Kept', name: 'under_score' },
      { label: 'Next', name: '--Next--Step--' }
    ],
    [{ label: 'Email', name: 'email' }, { label: 'Phone', name: 'EMAIL' }],
    [{ label: 'Subject', name: '' }, { label: 'Other', name: 'subject-field' }],
    [{ label: '名前' }, { label: 'Email' }, { label: 'X', name: 'field-1' }]
  ];

  it('gives every field the same key in TypeScript as in the exported Svelte, old and new', () => {
    for (const vector of VECTORS) {
      const fields = vector.map((f, i) => ({ id: `f${i}`, type: 'text', required: false, placeholder: '', ...f }));
      const expected = fields.map((f, i) => formFieldKey(f, i));
      expect(rendered('current', fields).names).toEqual(expected);
      expect(rendered('legacy', fields).names).toEqual(expected);
    }
  });

  it('refuses to send while two fields share a key, and says why', () => {
    const fields = (names: string[]) => names.map((name, i) => ({ id: `f${i}`, label: `Field ${i}`, name, type: 'text', required: false, placeholder: '' }));
    const clashing = rendered('current', fields(['email', 'EMAIL'])).html;
    expect(formKeyClashes(fields(['email', 'EMAIL']))).toEqual([{ key: 'email', indexes: [0, 1] }]);
    expect(clashing).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
    expect(clashing).toContain('Two fields of this form have the same name, so it cannot be sent.');
    const distinct = rendered('current', fields(['email', 'phone'])).html;
    expect(distinct).not.toMatch(/<button[^>]*type="submit"[^>]*disabled/);
    expect(distinct).not.toContain('have the same name');
  });
});

describe('keys stay distinct and stable through edits', () => {
  it('accepts a clashing name, keeps it as typed, and names both fields in a warning (issue #198)', () => {
    const { s: s0, nodeId } = withForm();
    expect(clashWarnings(s0)).toEqual([]);
    const s = edit(s0, nodeId, { type: 'instance.setProp', itemId: idOf(s0, nodeId, 'Phone'), field: 'name', value: 'EMAIL' });
    expect(fieldsOf(s, nodeId).find((f) => f.label === 'Phone')!.name).toBe('EMAIL');
    const [warning, ...rest] = clashWarnings(s);
    expect(rest).toEqual([]);
    expect(warning).toMatchObject({ severity: 'warning', nodeId });
    expect(warning.message).toContain('“Email” and “Phone” fields are both sent as “email”');
    expect(warning.message).toContain('visitors cannot send the form');
    // The field editor flags both fields, each naming the other, and says what every field is sent as.
    const fields = fieldsOf(s, nodeId);
    expect(fields.map((_, i) => formKeyNote(fields, i).error)).toEqual([
      undefined,
      '“Phone” is also sent as “email”. Give each field its own name.',
      '“Email” is also sent as “email”. Give each field its own name.',
      undefined
    ]);
    expect(formKeyNote(fields, 3).hint).toBe('Sent as “message”. Changing the label keeps it; clear it to make a new one from the label.');
    const same = [{ label: 'Email', name: 'email' }, { label: 'Email', name: '' }, { label: '', name: 'email' }];
    expect(formKeyNote(same, 0).error).toBe('“Email” (field 2) and field 3 are also sent as “email”. Give each field its own name.');
    // Swapping two names one at a time passes through the clash and out of it.
    const swapped = edit(s, nodeId, { type: 'instance.setProp', itemId: idOf(s, nodeId, 'Email'), field: 'name', value: 'phone' });
    expect(clashWarnings(swapped)).toEqual([]);
    expect(keysOf(swapped, nodeId)).toMatchObject({ [idOf(s, nodeId, 'Email')]: 'phone', [idOf(s, nodeId, 'Phone')]: 'email' });
  });

  it('gives added fields keys of their own, keeps them when the label changes, and regenerates on a clear', () => {
    const { s: s0, nodeId } = withForm();
    const s1 = edit(s0, nodeId, { type: 'instance.listInsert' }, { type: 'instance.listInsert' });
    const [a, b] = fieldsOf(s1, nodeId).slice(-2);
    expect([a.name, b.name]).toEqual(['field', 'field-2']);
    const s2 = edit(s1, nodeId, { type: 'instance.setProp', itemId: a.id, field: 'label', value: 'Company' });
    expect(keysOf(s2, nodeId)[a.id]).toBe('field');
    const s3 = edit(s2, nodeId, { type: 'instance.setProp', itemId: a.id, field: 'name', value: '' });
    expect(keysOf(s3, nodeId)[a.id]).toBe('company');
    // A field the agent adds with a label gets its key from it, numbered past keys already in use.
    const s4 = edit(s3, nodeId, { type: 'instance.listInsert', index: 0, item: { label: 'Email', type: 'email' } });
    expect(fieldsOf(s4, nodeId)[0].name).toBe('email-2');
    const s5 = edit(s4, nodeId, { type: 'instance.listInsert', item: { label: 'Subject' } }, { type: 'instance.listInsert', item: { label: '件名' } });
    // "field" is free again once Company took its own key; a label with nothing to slug starts from it.
    expect(fieldsOf(s5, nodeId).slice(-2).map((f) => f.name)).toEqual(['subject-field', 'field']);
    expect(clashWarnings(s5)).toEqual([]);
    // Adding fields moved no key already there.
    for (const [id, key] of Object.entries(keysOf(s3, nodeId))) expect(keysOf(s5, nodeId)[id]).toBe(key);
  });

  it('keeps explicit keys when a label is translated', () => {
    const { s: s0, nodeId } = withForm();
    const before = keysOf(s0, nodeId);
    const s = edit(s0, nodeId, { type: 'instance.setProp', itemId: idOf(s0, nodeId, 'Phone'), field: 'label', value: 'Téléphone' }, { type: 'instance.setProp', itemId: idOf(s0, nodeId, 'Email'), field: 'label', value: 'メール' });
    expect(keysOf(s, nodeId)).toEqual(before);
    expect(fieldsOf(s, nodeId).map((f) => f.name)).toEqual(['name', 'email', 'phone', 'message']);
  });

  it('pins keys that came from a label or a position before a move, a removal or a translation could change them', () => {
    const legacy = [
      { id: 'a', label: '名前', name: '', type: 'text', required: true, placeholder: '' },
      { id: 'b', label: '電話', name: '', type: 'tel', required: false, placeholder: '' },
      { id: 'c', label: 'Email', name: '', type: 'email', required: true, placeholder: '' },
      { id: 'd', label: 'Odd', name: '!!!', type: 'text', required: false, placeholder: '' }
    ];
    const { s: s0, nodeId } = withForm(legacy, LEGACY);
    const sent = { a: 'field-1', b: 'field-2', c: 'email', d: 'field-4' };
    expect(keysOf(s0, nodeId)).toEqual(sent);
    const moved = edit(s0, nodeId, { type: 'instance.listMove', itemId: 'd', index: 0 }, { type: 'instance.listMove', itemId: 'b', index: 0 });
    expect(fieldsOf(moved, nodeId).map((f) => f.id)).toEqual(['b', 'd', 'a', 'c']);
    expect(keysOf(moved, nodeId)).toEqual(sent);
    const translated = edit(moved, nodeId, { type: 'instance.setProp', itemId: 'c', field: 'label', value: 'Courriel' });
    expect(keysOf(translated, nodeId)).toEqual(sent);
    const { s: s1, nodeId: n1 } = withForm(legacy, LEGACY);
    const removed = edit(s1, n1, { type: 'instance.listRemove', itemId: 'a' });
    expect(keysOf(removed, n1)).toEqual({ b: 'field-2', c: 'email', d: 'field-4' });
  });

  it('keeps each field’s key by identity when the agent rewrites the whole list, even one that already clashed', () => {
    // A blank, unsluggable label at position 2 and a field typed as "field-2": the form already sends both as field-2.
    const legacy = [
      { id: 'a', label: 'Email', name: 'email', type: 'email', required: true, placeholder: '' },
      { id: 'b', label: '電話', name: '', type: 'tel', required: false, placeholder: '' },
      { id: 'c', label: 'Other', name: 'field-2', type: 'text', required: false, placeholder: '' }
    ];
    const { s: s0, nodeId } = withForm(legacy, LEGACY);
    expect(clashWarnings(s0)).toHaveLength(1);
    expect(clashWarnings(s0)[0].message).toContain('“電話” and “Other” fields are both sent as “field-2”, so the form service cannot tell those answers apart');
    const rewritten = edit(s0, nodeId, {
      type: 'instance.setProp',
      value: [
        { id: 'c', label: 'Autre', type: 'text' },
        { id: 'b', label: 'Téléphone', type: 'tel' },
        { id: 'a', label: 'Courriel', type: 'email' },
        { label: 'Message', type: 'textarea' }
      ]
    });
    const keys = keysOf(rewritten, nodeId);
    // "c" omitted its name, so it keeps the key it was sent under; "b" is pinned to its old positional key.
    expect([keys.a, keys.b, keys.c]).toEqual(['email', 'field-2', 'field-2']);
    expect(fieldsOf(rewritten, nodeId)[3].name).toBe('message');
    expect(clashWarnings(rewritten)).toHaveLength(1);
    expect(clashWarnings(rewritten)[0].message).toContain('“Autre” and “Téléphone” fields are both sent as “field-2”');
  });

  it('leaves forms with custom key code alone', () => {
    const custom = { ...contactForm, owner: 'project' as const, source: contactForm.source!.replace("'subject', ", '') };
    const legacy = [
      { id: 'a', label: 'Subject', name: '', type: 'text', required: false, placeholder: '' },
      { id: 'b', label: 'Same', name: 'x', type: 'text', required: false, placeholder: '' },
      { id: 'c', label: 'Same', name: 'x', type: 'text', required: false, placeholder: '' }
    ];
    const { s: s0, nodeId } = withForm(legacy, custom);
    const s = edit(s0, nodeId, { type: 'instance.listMove', itemId: 'a', index: 2 });
    expect(fieldsOf(s, nodeId).map((f) => f.name)).toEqual(['x', 'x', '']);
    expect(clashWarnings(s)).toEqual([]);
  });
});

describe('keys survive save, reopen and export', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

  it('stores the settled keys and exports them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-form-keys-'));
    dirs.push(dir);
    const { s: start, nodeId } = withForm();
    const session = await ProjectSession.create(dir, start);
    const op = (o: Record<string, unknown>) => ({ owner: owner(start), nodeId, prop: 'fields', ...o }) as EditOperation;
    const added = await session.apply({ operations: [op({ type: 'instance.listInsert', item: { label: 'Company' } })] }, { label: 'Add field' });
    expect(added.ok).toBe(true);
    const company = idOf(session.state, nodeId, 'Company');
    await session.apply({ operations: [op({ type: 'instance.setProp', itemId: company, field: 'label', value: 'Entreprise' })] }, { label: 'Rename' });
    await session.apply({ operations: [op({ type: 'instance.listMove', itemId: company, index: 0 })] }, { label: 'Move' });
    const before = keysOf(session.state, nodeId);
    expect(before[company]).toBe('company');
    await session.close();

    const again = await ProjectSession.open(dir, 'test');
    try {
      expect(keysOf(again.state, nodeId)).toEqual(before);
      expect(clashWarnings(again.state)).toEqual([]);
      const page = generateProject(again.state).get('src/routes/+page.svelte')!;
      for (const key of Object.values(before)) expect(page).toContain(JSON.stringify(key));
    } finally {
      await again.close();
    }
  });
});
