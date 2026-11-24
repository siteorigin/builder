/**
 * Export readiness (issue 17): the website export names each contact form visitors cannot send, in Project health's
 * own words, and every note or finding that can be fixed in the editor leads to where it is fixed: the form's
 * settings, or a field of Site details. A note about an earlier export says once it was fixed that the files need
 * exporting again.
 */
import { describe, expect, it } from 'vitest';
import type { InstanceNode, NodeTree, OwnerRef, ProjectState } from '@shared/types';
import type { Diagnostic, ExportNote } from '@shared/api';
import { createStarterState } from '@catalogue/starters';
import { FORM_SERVICES } from '@catalogue/foundation/form';
import { installComponent, makeInstance } from '@engine/install';
import { applyOperations } from '@engine/apply';
import { formNameDiagnostics, validateState, websiteFormNotes, websiteFormProblems } from '@engine/validate';
import { siteEntries } from '@generator/index';
import { publicUrlNote, publicUrlWarning } from '../../src/main/export';
import { destinationForDiagnostic, destinationLabel, formDestinationField, noteState } from '../../src/renderer/src/lib/destinations';

const fresh = () => createStarterState('business', 'Test Studio', false);
const apply = (s: ProjectState, ops: Parameters<typeof applyOperations>[1]) => {
  const r = applyOperations(s, ops);
  return r.state;
};

/** A Lookbook page holding a new contact form, as inserted: its service setting left blank. */
function lookbook(props: Record<string, unknown> = {}): { s: ProjectState; node: InstanceNode; pageId: string } {
  const s = apply(fresh(), [{ type: 'page.create', pageId: 'pg_lookbook', title: 'Lookbook', route: '/lookbook/' }]);
  const node = place(s, s.pages.pg_lookbook, props);
  return { s, node, pageId: 'pg_lookbook' };
}

function place(s: ProjectState, tree: NodeTree, props: Record<string, unknown> = {}): InstanceNode {
  const def = s.components[installComponent(s, 'contact.form')];
  const node = makeInstance(def, props);
  tree.nodes[node.id] = node;
  tree.rootIds.push(node.id);
  return node;
}

const siteEntryIds = (s: ProjectState) => siteEntries(s).map((e) => e.entry.id);
const healthForms = (s: ProjectState) => validateState(s).filter((d) => d.code === 'FORM_UNCONNECTED');
const at = (d: Pick<Diagnostic, 'owner' | 'nodeId'>) => `${d.owner?.kind}:${d.owner?.id}:${d.nodeId}`;

describe('the website’s contact forms visitors cannot send', () => {
  it('are Project health’s own findings, naming the page, each leading to its form', () => {
    const { s, node } = lookbook();
    const health = healthForms(s).filter((d) => d.nodeId === node.id);
    expect(health).toHaveLength(1);
    expect(websiteFormProblems(s)).toEqual(health);
    expect(health[0].message).toBe(`Lookbook: the contact form is not connected to a form service, so visitors cannot send it. ${FORM_SERVICES.endpoint.missing}`);
    expect(websiteFormNotes(s)).toEqual([{ message: health[0].message, destination: { kind: 'form', owner: { kind: 'page', id: 'pg_lookbook' }, nodeId: node.id, setting: 'connection' } }]);
  });

  it('tells two forms with the same words apart by where they lead', () => {
    const { s, node } = lookbook();
    const second = place(s, s.pages.pg_lookbook);
    const notes = websiteFormNotes(s);
    expect(notes.map((n) => n.message)).toEqual([notes[0].message, notes[0].message]);
    expect(notes.map((n) => n.destination?.kind === 'form' && n.destination.nodeId)).toEqual([node.id, second.id]);
  });

  it('leaves out a connected form', () => {
    const { s } = lookbook({ endpoint: 'https://formspree.io/f/abcd1234' });
    expect(websiteFormProblems(s)).toEqual([]);
  });

  it('leaves out a form on a draft, which the website leaves out, while Project health still lists it', () => {
    const { s, node } = lookbook();
    const drafted = apply(s, [{ type: 'page.update', pageId: 'pg_lookbook', draft: true }]);
    expect(healthForms(drafted).map(at)).toContain(`page:pg_lookbook:${node.id}`);
    expect(websiteFormProblems(drafted)).toEqual([]);
  });

  it('lists a form in the shared footer while a published page or entry shows it', () => {
    const s = fresh();
    const node = place(s, s.site.shell.footer);
    expect(websiteFormProblems(s).map(at)).toEqual([`shell:footer:${node.id}`]);
    expect(websiteFormProblems(s)[0].message).toMatch(/^Footer: the contact form is not connected/);
    for (const id of s.site.pageOrder) s.pages[id].showFooter = false;
    expect(websiteFormProblems(s)).toEqual([]);
    // A draft entry shows nothing to visitors; a published one shows the footer.
    const drafted = apply(s, [{ type: 'collection.create', collectionId: 'posts' }, { type: 'entry.create', collectionId: 'posts', entryId: 'en_soon', title: 'Coming soon' }]);
    expect(websiteFormProblems(drafted)).toEqual([]);
    const published = apply(drafted, [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_soon', draft: false }]);
    expect(websiteFormProblems(published).map(at)).toEqual([`shell:footer:${node.id}`]);
  });

  it('lists a form in a collection’s layout only while an entry of it is published', () => {
    const drafted = apply(fresh(), [{ type: 'collection.create', collectionId: 'posts' }, { type: 'entry.create', collectionId: 'posts', entryId: 'en_soon', title: 'Coming soon' }]);
    const layout = drafted.collections.posts.settings.template!;
    const node = place(drafted, layout);
    expect(healthForms(drafted).map(at)).toContain(`template:posts:${node.id}`);
    expect(websiteFormProblems(drafted).filter((d) => d.owner?.kind === 'template')).toEqual([]);
    const published = apply(drafted, [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_soon', draft: false }]);
    expect(websiteFormProblems(published).filter((d) => d.owner?.kind === 'template').map(at)).toEqual([`template:posts:${node.id}`]);
  });

  it('judges a layout’s form that takes its endpoint from each entry as each entry’s page is built', () => {
    // Entry content › Form endpoint URL › each entry's excerpt: the generator reads it from the entry, so the layout's
    // default decides nothing, and an entry with a usable address can send.
    const s = apply(fresh(), [
      { type: 'collection.create', collectionId: 'posts' },
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_open', title: 'Open studio', draft: false, excerpt: 'https://formspree.io/f/abcd1234' }
    ]);
    const node = place(s, s.collections.posts.settings.template!, { endpoint: { $entry: 'excerpt' } });
    expect(healthForms(s).map(at)).not.toContain(`template:posts:${node.id}`);
    expect(websiteFormProblems(s)).toEqual([]);
    // A published entry whose excerpt is no address: its page's form cannot send, and the finding names it.
    const blank = apply(s, [{ type: 'entry.create', collectionId: 'posts', entryId: 'en_blank', title: 'Coming soon', draft: false }]);
    const message = `Posts layout: the contact form is not connected to a form service on the “Coming soon” entry, so visitors cannot send it there. ${FORM_SERVICES.endpoint.missing}`;
    expect(websiteFormProblems(blank).map((d) => [at(d), d.message])).toEqual([[`template:posts:${node.id}`, message]]);
    expect(healthForms(blank).filter((d) => d.owner?.kind === 'template').map((d) => d.message)).toEqual([message]);
    // Kept as a draft, it is not on the website; Project health still says so.
    const drafted = apply(blank, [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_blank', draft: true }]);
    expect(websiteFormProblems(drafted)).toEqual([]);
    expect(healthForms(drafted).filter((d) => d.owner?.kind === 'template').map((d) => d.message)).toEqual([message]);
    // Go to form shows the layout on that entry, at the entry content its endpoint reads.
    const dest = { kind: 'form' as const, owner: { kind: 'template' as const, id: 'posts' }, nodeId: node.id, setting: 'connection' as const };
    expect(formDestinationField(blank, dest)).toEqual({ prop: 'endpoint', label: 'Form endpoint URL', entryId: 'en_blank', entryBound: true, entryField: 'excerpt' });
    // A draft that cannot send either, listed first: the published entry is still the one shown, as the export named it.
    const withDraft = apply(blank, [
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_later', title: 'Later' },
      { type: 'entry.reorder', collectionId: 'posts', entryIds: ['en_later', 'en_open', 'en_blank'] }
    ]);
    expect(siteEntryIds(withDraft)[0]).toBe('en_later');
    expect(formDestinationField(withDraft, dest)?.entryId).toBe('en_blank');
    // With only the draft failing, Project health's finding leads to the draft.
    const onlyDraft = apply(withDraft, [{ type: 'entry.update', collectionId: 'posts', entryId: 'en_blank', excerpt: 'https://formspree.io/f/abcd1234' }]);
    expect(formDestinationField(onlyDraft, dest)?.entryId).toBe('en_later');
    // A page's form has no entry to read from: the binding is exported empty, and the default decides.
    const { s: page, node: pageForm } = lookbook({ endpoint: { $entry: 'excerpt' } });
    expect(healthForms(page).map(at)).toContain(`page:pg_lookbook:${pageForm.id}`);
  });

  it('never stops Project health over a setting written by hand that cannot be read', () => {
    const unreadable = { toString: null };
    const { s, node } = lookbook({ provider: 'web3forms', accessKey: unreadable });
    expect(() => validateState(s)).not.toThrow();
    // A layout's form reading its service from each entry, with a key of its own no one can read.
    const posts = apply(fresh(), [{ type: 'collection.create', collectionId: 'posts' }, { type: 'entry.create', collectionId: 'posts', entryId: 'en_soon', title: 'Coming soon', draft: false, excerpt: 'web3forms' }]);
    place(posts, posts.collections.posts.settings.template!, { provider: { $entry: 'excerpt' }, accessKey: unreadable });
    expect(() => validateState(posts)).not.toThrow();
    expect(() => websiteFormProblems(posts)).not.toThrow();
    expect(node.id).toBeTruthy();
  });
});

describe('the public URL note', () => {
  it('leads to the Public URL field, and says the URL is optional and where it is', () => {
    const s = fresh();
    s.site.baseUrl = '';
    expect(publicUrlNote(s)).toEqual({ message: publicUrlWarning(s), destination: { kind: 'site', field: 'baseUrl' } });
    expect(publicUrlWarning(s)).toBe(
      'No public site URL is set, so canonical links, social image URLs and the sitemap were omitted. If the site will have its own address, add it as the Public URL in Site styles › Site details.'
    );
    s.site.baseUrl = 'https://example.com';
    expect(publicUrlNote(s)).toBeNull();
  });
});

describe('where a Project health finding leads', () => {
  it('opens a form’s settings for its form findings, and Site details for a site image', () => {
    const { s, node } = lookbook();
    const owner: OwnerRef = { kind: 'page', id: 'pg_lookbook' };
    const finding = (code: string): Diagnostic => ({ severity: 'warning', code, message: '', owner, nodeId: node.id });
    expect(destinationForDiagnostic(s, finding('FORM_UNCONNECTED'))).toEqual({ kind: 'form', owner, nodeId: node.id, setting: 'connection' });
    expect(destinationForDiagnostic(s, finding('FORM_FIELD_KEYS'))).toEqual({ kind: 'form', owner, nodeId: node.id, setting: 'fieldKeys' });
    expect(destinationForDiagnostic(s, finding('FORM_NO_CHOICES'))).toEqual({ kind: 'form', owner, nodeId: node.id, setting: 'fieldChoices' });
    expect(destinationForDiagnostic(s, finding('FORM_NAME_DUPLICATE'))).toEqual({ kind: 'form', owner, nodeId: node.id, setting: 'formName' });
    // Anything else keeps its own action.
    expect(destinationForDiagnostic(s, finding('BUTTON_UNLINKED'))).toBeNull();
    // The site's icon or sharing image, set to something that is not a picture: Site details.
    expect(destinationForDiagnostic(s, { severity: 'error', code: 'ASSET_NOT_IMAGE', message: '', site: 'favicon' })).toEqual({ kind: 'site', field: 'favicon' });
    expect(destinationForDiagnostic(s, { severity: 'error', code: 'ASSET_NOT_IMAGE', message: '', site: 'socialImage' })).toEqual({ kind: 'site', field: 'socialImage' });
    // A page's own sharing image is the page's, not the site's.
    expect(destinationForDiagnostic(s, { severity: 'error', code: 'ASSET_NOT_IMAGE', message: '', owner, site: 'socialImage' })).toBeNull();
    expect([destinationLabel({ kind: 'form', owner, nodeId: node.id, setting: 'connection' }), destinationLabel({ kind: 'site', field: 'baseUrl' })]).toEqual(['Go to form', 'Go to Public URL']);
  });

  it('keeps Show on page for a clash found at a placement whose design holds the form', () => {
    const s = fresh();
    const form = s.components[installComponent(s, 'contact.form')];
    const wrapper = Object.values(s.components).find((d) => d.componentId === 'cta.banner')!;
    const inner = makeInstance(form, { provider: 'netlify' });
    wrapper.tree!.nodes[inner.id] = inner;
    (wrapper.tree!.nodes[wrapper.tree!.rootIds[0]] as { children: string[] }).children.push(inner.id);
    const home = s.pages[s.site.homePageId];
    const placed = Object.values(home.nodes).find((n) => n.kind === 'instance' && n.definitionId === wrapper.id)!;
    const again = { ...structuredClone(placed), id: 'n_banner_again' };
    home.nodes[again.id] = again;
    home.rootIds.push(again.id);
    const clashes = formNameDiagnostics(s).filter((d) => d.owner?.kind === 'page');
    expect(clashes.length).toBeGreaterThan(0);
    for (const d of clashes) expect(destinationForDiagnostic(s, d)).toBeNull();
    // A setting of the placement's own that happens to share the name is not the form's.
    wrapper.properties.formName = { type: 'string', label: 'Form name', default: '' } as never;
    for (const d of clashes) expect(destinationForDiagnostic(s, d)).toBeNull();
  });

  it('focuses the setting the form’s service needs now, or the service when none can be read', () => {
    const { s, node } = lookbook();
    const dest = { kind: 'form' as const, owner: { kind: 'page' as const, id: 'pg_lookbook' }, nodeId: node.id, setting: 'connection' as const };
    expect(formDestinationField(s, dest)?.prop).toBe('endpoint');
    node.props.provider = 'web3forms';
    expect(formDestinationField(s, dest)?.prop).toBe('accessKey');
    node.props.provider = 'carrier-pigeon';
    expect(formDestinationField(s, dest)?.prop).toBe('provider');
    expect(formDestinationField(s, { ...dest, setting: 'formName' })?.prop).toBe('formName');
    // A field finding opens the row with the problem: the second of two fields sent under one name, or a question with
    // no choices. With none found, the list itself.
    const fields = [
      { id: 'f_name', label: 'Name', name: 'name', type: 'text' },
      { id: 'f_pick', label: 'Pick one', name: 'pick', type: 'choice', options: [] },
      { id: 'f_again', label: 'Your name', name: 'name', type: 'text' }
    ];
    node.props.fields = fields;
    expect(formDestinationField(s, { ...dest, setting: 'fieldKeys' })).toEqual({ prop: 'fields', label: 'Fields', itemId: 'f_again', field: 'name' });
    expect(formDestinationField(s, { ...dest, setting: 'fieldChoices' })).toEqual({ prop: 'fields', label: 'Fields', itemId: 'f_pick', field: 'options' });
    node.props.fields = [fields[0]];
    expect(formDestinationField(s, { ...dest, setting: 'fieldKeys' })).toEqual({ prop: 'fields', label: 'Fields' });
    // A form deleted since has nowhere to go.
    delete s.pages.pg_lookbook.nodes[node.id];
    expect(formDestinationField(s, dest)).toBeNull();
  });

  it('leads each of a form’s field findings to its own row', () => {
    const { s, node } = lookbook();
    node.props.fields = [
      { id: 'f_one', label: 'Pick one', name: 'one', type: 'choice', options: [] },
      { id: 'f_two', label: 'Pick two', name: 'two', type: 'choice', options: [] }
    ];
    const findings = validateState(s).filter((d) => d.code === 'FORM_NO_CHOICES' && d.nodeId === node.id);
    expect(findings.map((d) => d.site)).toEqual([`${node.id}|fields|f_one`, `${node.id}|fields|f_two`]);
    const rows = findings.map((d) => formDestinationField(s, destinationForDiagnostic(s, d) as Parameters<typeof formDestinationField>[1])?.itemId);
    expect(rows).toEqual(['f_one', 'f_two']);
    // A row deleted since: the first that still has the problem.
    node.props.fields = [(node.props.fields as unknown[])[1]];
    expect(formDestinationField(s, destinationForDiagnostic(s, findings[0]) as Parameters<typeof formDestinationField>[1])?.itemId).toBe('f_two');
  });
});

describe('an earlier export’s note, read against the project now', () => {
  it('leads to the form while it still cannot send, then says to export again', () => {
    const { s, node } = lookbook();
    // Another form visitors cannot send stays on the site throughout: the note is about its own form only.
    place(s, s.pages[s.site.homePageId]);
    const note = websiteFormNotes(s).find((n) => n.destination?.kind === 'form' && n.destination.nodeId === node.id)!;
    expect(noteState(s, note, websiteFormNotes(s))).toBe('open');
    // Renaming the page changes the words, not the form the note is about.
    const renamed = apply(s, [{ type: 'page.update', pageId: 'pg_lookbook', title: 'Look book' }]);
    expect(noteState(renamed, note, websiteFormNotes(renamed))).toBe('open');
    // Another service with its setting still missing is still a form visitors cannot send.
    const switched = apply(s, [{ type: 'instance.setProp', owner: { kind: 'page', id: 'pg_lookbook' }, nodeId: node.id, prop: 'provider', value: 'web3forms' }]);
    expect(noteState(switched, note, websiteFormNotes(switched))).toBe('open');
    const connected = apply(s, [{ type: 'instance.setProp', owner: { kind: 'page', id: 'pg_lookbook' }, nodeId: node.id, prop: 'endpoint', value: 'https://formspree.io/f/abcd1234' }]);
    expect(noteState(connected, note, websiteFormNotes(connected))).toBe('fixed');
    const drafted = apply(s, [{ type: 'page.update', pageId: 'pg_lookbook', draft: true }]);
    expect(noteState(drafted, note, websiteFormNotes(drafted))).toBe('gone');
    // Connected and then kept as a draft: off the website, not something visitors can now send.
    const connectedDraft = apply(connected, [{ type: 'page.update', pageId: 'pg_lookbook', draft: true }]);
    expect(noteState(connectedDraft, note, websiteFormNotes(connectedDraft))).toBe('gone');
    const removed = apply(s, [{ type: 'node.remove', owner: { kind: 'page', id: 'pg_lookbook' }, nodeId: node.id }]);
    expect(noteState(removed, note, websiteFormNotes(removed))).toBe('gone');
  });

  it('leads to the Public URL until a usable one is saved', () => {
    const s = fresh();
    s.site.baseUrl = '';
    const note = publicUrlNote(s)!;
    expect(noteState(s, note, [])).toBe('open');
    s.site.baseUrl = 'example.com';
    expect(noteState(s, note, [])).toBe('open');
    s.site.baseUrl = 'https://example.com';
    expect(noteState(s, note, [])).toBe('fixed');
    // Cleared again (or undone): the note leads to the field again.
    s.site.baseUrl = '';
    expect(noteState(s, note, [])).toBe('open');
    s.site.baseUrl = 'https://example.com';
    // A note with nothing to fix has no state.
    expect(noteState(s, { message: 'Private files were left out.' } satisfies ExportNote, [])).toBeNull();
  });
});
