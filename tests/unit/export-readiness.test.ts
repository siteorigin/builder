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

  it('does not call a layout’s form unconnected when each entry gives it its endpoint', () => {
    // Entry content › Form endpoint URL › each entry's excerpt: the generator reads it from the entry, so Project health
    // cannot judge it from the layout's default, and neither does the export.
    const s = apply(fresh(), [{ type: 'collection.create', collectionId: 'posts' }, { type: 'entry.create', collectionId: 'posts', entryId: 'en_soon', title: 'Coming soon', draft: false }]);
    const node = place(s, s.collections.posts.settings.template!, { endpoint: { $entry: 'excerpt' } });
    expect(healthForms(s).map(at)).not.toContain(`template:posts:${node.id}`);
    expect(websiteFormProblems(s)).toEqual([]);
    // A page's form has no entry to read from: the binding is exported empty, and the default decides.
    const { s: page, node: pageForm } = lookbook({ endpoint: { $entry: 'excerpt' } });
    expect(healthForms(page).map(at)).toContain(`page:pg_lookbook:${pageForm.id}`);
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
    expect(destinationForDiagnostic(s, finding('FORM_FIELD_KEYS'))).toEqual({ kind: 'form', owner, nodeId: node.id, setting: 'fields' });
    expect(destinationForDiagnostic(s, finding('FORM_NO_CHOICES'))).toEqual({ kind: 'form', owner, nodeId: node.id, setting: 'fields' });
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
  });

  it('focuses the setting the form’s service needs now, or the service when none can be read', () => {
    const { s, node } = lookbook();
    const dest = { kind: 'form' as const, owner: { kind: 'page' as const, id: 'pg_lookbook' }, nodeId: node.id, setting: 'connection' as const };
    expect(formDestinationField(s, dest)?.prop).toBe('endpoint');
    node.props.provider = 'web3forms';
    expect(formDestinationField(s, dest)?.prop).toBe('accessKey');
    node.props.provider = 'carrier-pigeon';
    expect(formDestinationField(s, dest)?.prop).toBe('provider');
    expect(formDestinationField(s, { ...dest, setting: 'fields' })?.prop).toBe('fields');
    expect(formDestinationField(s, { ...dest, setting: 'formName' })?.prop).toBe('formName');
    // A form deleted since has nowhere to go.
    delete s.pages.pg_lookbook.nodes[node.id];
    expect(formDestinationField(s, dest)).toBeNull();
  });
});

describe('an earlier export’s note, read against the project now', () => {
  it('leads to the form while it still cannot send, then says to export again', () => {
    const { s, node } = lookbook();
    const [note] = websiteFormNotes(s);
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
    // A note with nothing to fix has no state.
    expect(noteState(s, { message: 'Private files were left out.' } satisfies ExportNote, [])).toBeNull();
  });
});
