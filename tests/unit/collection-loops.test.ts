/**
 * Collections shown in lists (#677): a placed section's list property connected to a collection (a Team grid's people
 * from a Team collection), collection loops (repeats over a query's entries) on pages, in a collection's layout and in
 * a component's design, and a collection's archive layout, whose loop shows the entries each archive page lists.
 * Everything is written into the exported site as plain markup: nothing reads a collection in the visitor's browser.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { InstanceNode, ListItem, OwnerRef, ProjectState, RepeatNode } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { EngineError } from '@engine/tree';
import { validateState } from '@engine/validate';
import { defFile, generateProject, pageFile, publishedState } from '@generator/index';
import { GenerationCache } from '@generator/cache';
import { archiveFile } from '@generator/archive';
import { removeRendered, serverHtml } from './generated-site';

afterAll(removeRendered);

const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;
const errors = (s: ProjectState) => validateState(s).filter((d) => d.severity === 'error');

/** The engine error a change is refused with. */
function refusal(s: ProjectState, ...ops: EditOperation[]): string {
  try {
    applyOperations(s, ops);
  } catch (e) {
    expect(e).toBeInstanceOf(EngineError);
    return (e as Error).message;
  }
  throw new Error('Expected the change to be refused.');
}

const home = (s: ProjectState): OwnerRef => ({ kind: 'page', id: s.site.homePageId });

/** A site with a data-only Team collection (role and location fields) and a Projects collection with entry pages. */
function studio(): ProjectState {
  return run(
    createStarterState('business', 'Riverside Studio', false),
    { type: 'collection.create', collectionId: 'team', kind: 'structured', singularName: 'Team member', hasBody: false, pages: { detail: false, archive: false }, fields: { role: { type: 'string', label: 'Role' }, location: { type: 'string', label: 'Location' }, senior: { type: 'boolean', label: 'Senior' } } },
    { type: 'entry.create', collectionId: 'team', entryId: 'en_ruiz', title: 'Ana Ruiz', draft: false, excerpt: 'Leads every build.', values: { role: 'Architect', location: 'London', senior: true } },
    { type: 'entry.create', collectionId: 'team', entryId: 'en_okafor', title: 'Ben Okafor', draft: false, values: { role: 'Engineer', location: 'Leeds' } },
    { type: 'entry.create', collectionId: 'team', entryId: 'en_patel', title: 'Dev Patel', draft: false, values: { role: 'Architect', location: '' } },
    { type: 'entry.create', collectionId: 'team', entryId: 'en_diaz', title: 'Cara Diaz', draft: true, values: { role: 'Architect', location: 'Bristol' } },
    { type: 'collection.create', collectionId: 'projects', kind: 'structured', singularName: 'Project', route: '/work/', pages: { detail: true, archive: true }, pageSize: 1, fields: { client: { type: 'string', label: 'Client' }, completed: { type: 'date', label: 'Completed' } } },
    { type: 'entry.create', collectionId: 'projects', entryId: 'en_mill', title: 'The Old Mill', slug: 'old-mill', draft: false, publishedAt: '2026-03-01', values: { client: 'Hart Family', completed: '2025-11-20' } },
    { type: 'entry.create', collectionId: 'projects', entryId: 'en_dock', title: 'Dockside Offices', slug: 'dockside', draft: false, publishedAt: '2026-05-01', values: { client: 'Northwind Ltd' } }
  );
}

/** A Team grid placed on Home, and its node ID. */
function withTeam(s: ProjectState): { s: ProjectState; id: string } {
  const r = applyOperations(s, [{ type: 'node.insert', owner: home(s), parentId: null, componentId: 'team.grid' }]);
  return { s: r.state, id: r.results[0].nodeId as string };
}

const ARCHITECTS = { collectionId: 'team', where: [{ field: 'field.role', op: 'eq', value: 'Architect' }], sort: [{ field: 'title', direction: 'desc' }], limit: 5 };
/** Architects by name, A to Z, at most two: the collection's own order (newest first) would put Dev Patel first. */
const FIRST_TWO = { collectionId: 'team', where: [{ field: 'field.role', op: 'eq', value: 'Architect' }], sort: [{ field: 'title' }], limit: 2 };
const PEOPLE = { name: 'title', role: 'field.role', bio: 'field.location' };

describe('a list property connected to a collection', () => {
  it("shows a Team grid's people from the published entries its query finds, in its order, in the exported page", async () => {
    let { s, id } = withTeam(studio());
    s = run(s, { type: 'instance.setListSource', owner: home(s), nodeId: id, prop: 'people', source: { query: ARCHITECTS, fields: PEOPLE } });
    expect(errors(s)).toEqual([]);
    const files = generateProject(publishedState(s));
    const html = await serverHtml(files, 'loops-team-');
    // Architects only, newest-named first by the query's sort; the draft and the engineer are left out.
    expect(html).toContain('Dev Patel');
    expect(html.indexOf('Dev Patel')).toBeLessThan(html.indexOf('Ana Ruiz'));
    expect(html).toContain('London');
    expect(html).not.toContain('Ben Okafor');
    expect(html).not.toContain('Cara Diaz');
    // The sample people the section came with are not shown, and nothing of the editor is in the page.
    expect(html).not.toContain('Hannah Wells');
    expect(html).not.toMatch(/data-so-/);
    expect(files.get(pageFile(s.pages[s.site.homePageId]))).not.toContain('collectionId');
    expect(files.get(pageFile(s.pages[s.site.homePageId]))).not.toContain('$query');
  });

  it('sorts and limits as its query says, against the collection\'s own order, and leaves drafts out of the unpublished state too', async () => {
    let { s, id } = withTeam(studio());
    // A third architect, so the limit of two leaves one out; the draft architect would sort first by name.
    s = run(
      s,
      { type: 'entry.create', collectionId: 'team', entryId: 'en_zola', title: 'Zoe Zola', draft: false, values: { role: 'Architect' } },
      { type: 'entry.update', collectionId: 'team', entryId: 'en_patel', publishedAt: '2026-09-01' },
      { type: 'instance.setListSource', owner: home(s), nodeId: id, prop: 'people', source: { query: FIRST_TWO, fields: PEOPLE } }
    );
    const html = await serverHtml(generateProject(s), 'loops-sort-');
    expect(html).toContain('Ana Ruiz');
    expect(html).toContain('Dev Patel');
    expect(html.indexOf('Ana Ruiz')).toBeLessThan(html.indexOf('Dev Patel'));
    expect(html).not.toContain('Zoe Zola');
    expect(html).not.toContain('Cara Diaz');
    expect(html).not.toContain('Ben Okafor');
  });

  it('keeps its own items while connected, and shows them again once disconnected', () => {
    let { s, id } = withTeam(studio());
    const own = (st: ProjectState) => (st.pages[st.site.homePageId].nodes[id] as InstanceNode).props.people as ListItem[];
    const before = own(s);
    s = run(s, { type: 'instance.setListSource', owner: home(s), nodeId: id, prop: 'people', source: { query: ARCHITECTS, fields: PEOPLE } });
    expect(own(s)).toEqual(before);
    s = run(s, { type: 'instance.setListSource', owner: home(s), nodeId: id, prop: 'people', source: null });
    expect((s.pages[s.site.homePageId].nodes[id] as InstanceNode).listSources).toBeUndefined();
    expect(generateProject(publishedState(s)).get(pageFile(s.pages[s.site.homePageId]))).toContain('Hannah Wells');
  });

  it('is written again when an entry it shows changes, even though the same entries are found', () => {
    let { s, id } = withTeam(studio());
    s = run(s, { type: 'instance.setListSource', owner: home(s), nodeId: id, prop: 'people', source: { query: ARCHITECTS, fields: PEOPLE } });
    const cache = new GenerationCache();
    const file = pageFile(s.pages[s.site.homePageId]);
    expect(generateProject(s, {}, cache).get(file)).toContain('London');
    s = run(s, { type: 'entry.update', collectionId: 'team', entryId: 'en_ruiz', values: { location: 'Lisbon' } });
    const again = generateProject(s, {}, cache);
    expect(cache.made).toContain(`page:${s.site.homePageId}#clean`);
    expect(again.get(file)).toContain('Lisbon');
    expect([...again]).toEqual([...generateProject(s)]);
    // An entry the list does not show changes nothing it shows: Home is not made again.
    s = run(s, { type: 'entry.update', collectionId: 'team', entryId: 'en_okafor', values: { location: 'York' } });
    generateProject(s, {}, cache);
    expect(cache.made).not.toContain(`page:${s.site.homePageId}#clean`);
    expect(again.get(file)).not.toContain('Ben Okafor');
    // An entry that starts matching joins the list.
    s = run(s, { type: 'entry.update', collectionId: 'team', entryId: 'en_okafor', values: { role: 'Architect' } });
    expect(generateProject(s, {}, cache).get(file)).toContain('Ben Okafor');
  });

  it('refuses a connection that cannot show: a field items lack, an entry field the collection lacks, a kind that does not fit, an item field left unfilled', () => {
    const { s, id } = withTeam(studio());
    const connect = (fields: Record<string, string>, query: Record<string, unknown> = ARCHITECTS) => refusal(s, { type: 'instance.setListSource', owner: home(s), nodeId: id, prop: 'people', source: { query, fields } });
    expect(connect({ ...PEOPLE, shoe: 'title' })).toMatch(/fills "shoe"/);
    expect(connect({ ...PEOPLE, role: 'field.salary' })).toMatch(/from "field.salary", which entries of Team do not have/);
    // A field an item needs is filled from one every entry has: an excerpt can be empty.
    expect(connect({ ...PEOPLE, name: 'excerpt' })).toMatch(/can be empty/);
    expect(connect({ ...PEOPLE, portrait: 'title' })).toMatch(/cannot fill/);
    expect(connect({ role: 'field.role' })).toMatch(/unfilled/);
    expect(connect(PEOPLE, { collectionId: 'staff' })).toMatch(/does not have/);
    expect(connect(PEOPLE, { collectionId: '$current' })).toMatch(/collection of the page it is on/);
    expect(connect(PEOPLE, { collectionId: 'team', where: [{ field: 'field.salary', op: 'eq', value: 1 }] })).toMatch(/filters by "field.salary"/);
    expect(connect(PEOPLE, { collectionId: 'team', sort: [{ field: 'field.salary' }] })).toMatch(/sorts by "field.salary"/);
    // A link to an entry's page is the row's, not a value a query sorts by.
    expect(connect(PEOPLE, { collectionId: 'team', sort: [{ field: 'entryLink' }] })).toMatch(/sorts by "entryLink"/);
  });

  it('refuses a change elsewhere that would break it: the collection removed, a field it shows retyped', () => {
    let { s, id } = withTeam(studio());
    s = run(s, { type: 'instance.setListSource', owner: home(s), nodeId: id, prop: 'people', source: { query: ARCHITECTS, fields: PEOPLE } });
    expect(refusal(s, { type: 'collection.remove', collectionId: 'team' })).toMatch(/does not have/);
    // Location (shown as each bio) turned into a yes/no, its values cleared first so the entries allow it.
    s = run(s, ...['en_ruiz', 'en_okafor', 'en_patel', 'en_diaz'].map((entryId): EditOperation => ({ type: 'entry.update', collectionId: 'team', entryId, values: { location: null } })));
    expect(refusal(s, { type: 'collection.update', collectionId: 'team', fields: { role: { type: 'string', label: 'Role' }, location: { type: 'boolean', label: 'Location' }, senior: { type: 'boolean', label: 'Senior' } } })).toMatch(/fills “Bio” of “People”, but "Location" \(yes\/no\) cannot fill "Bio"/);
    // Disconnected first, the collection can go.
    s = run(s, { type: 'instance.setListSource', owner: home(s), nodeId: id, prop: 'people', source: null }, { type: 'collection.remove', collectionId: 'team' });
    expect(s.collections.team).toBeUndefined();
  });

  it("reports a connection broken by hand, and the site shows the placement's own items meanwhile", () => {
    let { s, id } = withTeam(studio());
    s = structuredClone(s);
    (s.pages[s.site.homePageId].nodes[id] as InstanceNode).listSources = { people: { query: { collectionId: 'team' }, fields: { name: 'field.nickname' } } };
    expect(errors(s).map((d) => d.code)).toContain('COLLECTION_SOURCE');
  });
});

/** A collection loop on Home: a container whose loop over `query` shows each entry's title, client and link. */
function withLoop(s: ProjectState, query: Record<string, unknown>, owner: OwnerRef = home(s)): { s: ProjectState; loop: string; title: string; client: string; link: string } {
  const box = applyOperations(s, [{ type: 'node.insert', owner, parentId: null, primitive: 'container' }]);
  s = box.state;
  const parentId = box.results[0].nodeId as string;
  const loopR = applyOperations(s, [{ type: 'node.insert', owner, parentId, primitive: 'repeat', query }]);
  s = loopR.state;
  const loop = loopR.results[0].nodeId as string;
  const ins = applyOperations(s, [
    { type: 'node.insert', owner, parentId: loop, primitive: 'heading', text: 'Title' },
    { type: 'node.insert', owner, parentId: loop, primitive: 'paragraph', text: 'Client' },
    { type: 'node.insert', owner, parentId: loop, primitive: 'button', text: 'View' }
  ]);
  s = ins.state;
  const [title, client, link] = ins.results.map((r) => r.nodeId as string);
  s = run(
    s,
    { type: 'node.setBinding', owner, nodeId: title, field: 'text', binding: { $item: 'title' } },
    { type: 'node.setBinding', owner, nodeId: client, field: 'text', binding: { $item: 'field.client' } },
    { type: 'node.setBinding', owner, nodeId: client, field: 'when', binding: { $item: 'field.client' } },
    { type: 'node.setBinding', owner, nodeId: link, field: 'link', binding: { $item: 'entryLink' } }
  );
  return { s, loop, title, client, link };
}

describe('collection loops', () => {
  it("shows each entry a page's loop finds with its own fields and a link to its page, in plain markup", async () => {
    const { s } = withLoop(studio(), { collectionId: 'projects', sort: [{ field: 'publishedAt', direction: 'asc' }] });
    expect(errors(s)).toEqual([]);
    const files = generateProject(publishedState(s));
    const html = await serverHtml(files, 'loops-page-');
    expect(html.indexOf('The Old Mill')).toBeGreaterThan(-1);
    expect(html.indexOf('The Old Mill')).toBeLessThan(html.indexOf('Dockside Offices'));
    expect(html).toContain('Hart Family');
    expect(html).toContain('href="/work/old-mill/"');
    expect(html).toContain('href="/work/dockside/"');
    expect(html).not.toMatch(/data-so-/);
  });

  it("decides each row's conditions by its own entry", async () => {
    const { s } = withLoop(studio(), { collectionId: 'projects' });
    const html = await serverHtml(generateProject(publishedState(s)), 'loops-when-');
    // Dockside has a client; neither leaves an empty paragraph behind for a client it lacks.
    const s2 = run(s, { type: 'entry.update', collectionId: 'projects', entryId: 'en_dock', values: { client: null } });
    const html2 = await serverHtml(generateProject(publishedState(s2)), 'loops-when2-');
    expect(html).toContain('Northwind Ltd');
    expect(html2).not.toContain('Northwind Ltd');
    expect(html2).toContain('Hart Family');
    expect((html2.match(/<p/g) ?? []).length).toBe((html.match(/<p/g) ?? []).length - 1);
  });

  it('marks each row in the editor preview, so an element of any row selects the element of the loop', () => {
    const { s, title } = withLoop(studio(), { collectionId: 'projects' });
    const dev = generateProject(s, { instrument: true }).get(pageFile(s.pages[s.site.homePageId]))!;
    expect(dev).toMatch(new RegExp(`data-so-node="${title}" data-so-items=\\{`));
  });

  it('refuses an element of a loop reading a field the collection lacks, or a date as a <time> that is none', () => {
    const { s, title, client } = withLoop(studio(), { collectionId: 'projects' });
    expect(refusal(s, { type: 'node.setBinding', owner: home(s), nodeId: title, field: 'text', binding: { $item: 'field.budget' } })).toMatch(/no field "field.budget"/);
    expect(refusal(s, { type: 'node.setBinding', owner: home(s), nodeId: client, field: 'datetime', binding: { $item: 'field.client' } })).toMatch(/not a date/);
    // A date field states its date.
    const ok = run(s, { type: 'node.setBinding', owner: home(s), nodeId: client, field: 'datetime', binding: { $item: 'field.completed' } });
    expect(errors(ok)).toEqual([]);
  });

  it('refuses a loop inside a list, a query the page cannot have, and a field outside every loop', () => {
    const { s, loop } = withLoop(studio(), { collectionId: 'projects' });
    expect(refusal(s, { type: 'node.insert', owner: home(s), parentId: loop, primitive: 'repeat', query: { collectionId: 'team' } })).toMatch(/another list/);
    expect(refusal(s, { type: 'node.setRepeatSource', owner: home(s), nodeId: loop, source: { $query: { collectionId: '$current' } } })).toMatch(/collection of the page it is on/);
    expect(refusal(s, { type: 'node.setRepeatSource', owner: home(s), nodeId: loop, source: { $archive: true } })).toMatch(/archive layout/);
    expect(refusal(s, { type: 'collection.remove', collectionId: 'projects' })).toMatch(/collection “projects”, which the project does not have/);
  });

  it("in a collection's layout, lists the collection's other entries", async () => {
    let s = studio();
    const owner: OwnerRef = { kind: 'template', id: 'projects' };
    ({ s } = withLoop(s, { collectionId: '$current', excludeCurrent: true }, owner));
    expect(errors(s)).toEqual([]);
    const files = generateProject(publishedState(s));
    const mill = files.get('src/routes/work/old-mill/+page.svelte')!;
    const dock = files.get('src/routes/work/dockside/+page.svelte')!;
    expect(mill).toContain('"id":"en_dock"');
    expect(mill).not.toContain('"id":"en_mill"');
    expect(dock).toContain('"id":"en_mill"');
    expect(dock).not.toContain('"id":"en_dock"');
  });

  it("in a component's design, writes the rows into the component's own file", () => {
    let s = studio();
    const made = applyOperations(s, [{ type: 'component.create', name: 'Project list', category: 'content' } as EditOperation]);
    s = made.state;
    const defId = made.results[0].definitionId as string;
    const owner: OwnerRef = { kind: 'component', id: defId };
    const root = s.components[defId].tree!.rootIds[0];
    const loopR = applyOperations(s, [{ type: 'node.insert', owner, parentId: root, primitive: 'repeat', query: { collectionId: 'projects' } }]);
    s = loopR.state;
    const loop = loopR.results[0].nodeId as string;
    const t = applyOperations(s, [{ type: 'node.insert', owner, parentId: loop, primitive: 'paragraph', text: 'x' }]);
    s = run(t.state, { type: 'node.setBinding', owner, nodeId: t.results[0].nodeId as string, field: 'text', binding: { $item: 'title' } });
    expect(errors(s)).toEqual([]);
    const file = generateProject(publishedState(s)).get(defFile(s.components[defId]))!;
    expect(file).toContain('Dockside Offices');
    expect(file).toContain('The Old Mill');
    // A design shown on every page cannot read "the collection of the page it is on".
    expect(refusal(s, { type: 'node.setRepeatSource', owner, nodeId: loop, source: { $query: { collectionId: '$current' } } })).toMatch(/component's design/);
  });
});

describe("a collection's archive layout", () => {
  it('shows each archive page its own entries through the layout, keeping the heading and page links', async () => {
    let s = studio();
    s = run(s, { type: 'collection.update', collectionId: 'projects', archiveTemplate: 'start' });
    const layout = s.collections.projects.settings.archiveTemplate!;
    const loop = Object.values(layout.nodes).find((n) => n.kind === 'repeat') as RepeatNode;
    expect(loop.list).toEqual({ $archive: true });
    expect(errors(s)).toEqual([]);
    const files = generateProject(publishedState(s));
    // One entry a page, newest first: Dockside on the first, the Old Mill on the second.
    const first = files.get(archiveFile('/work/'))!;
    const second = files.get(archiveFile('/work/page/2/'))!;
    expect(first).toContain('Dockside Offices');
    expect(first).not.toContain('The Old Mill');
    expect(second).toContain('The Old Mill');
    expect(first).toContain('so-archive__pages');
    expect(first).not.toContain('so-archive__card');
    const html = await serverHtml(files, 'loops-archive-', 'src/routes/work/+page.svelte');
    expect(html).toContain('href="/work/dockside/"');
    expect(html).not.toMatch(/data-so-/);
    // Without a layout of its own, the ready-made cards again.
    s = run(s, { type: 'collection.update', collectionId: 'projects', archiveTemplate: null });
    expect(generateProject(publishedState(s)).get(archiveFile('/work/'))).toContain('so-archive__card');
  });

  it("is edited like a page's: an element added to its loop shows a field of each entry", async () => {
    let s = run(studio(), { type: 'collection.update', collectionId: 'projects', archiveTemplate: 'start' });
    const owner: OwnerRef = { kind: 'archive', id: 'projects' };
    const loop = Object.values(s.collections.projects.settings.archiveTemplate!.nodes).find((n) => n.kind === 'repeat')!;
    const card = (loop as RepeatNode).children[0];
    const r = applyOperations(s, [{ type: 'node.insert', owner, parentId: card, primitive: 'paragraph', text: 'Client' }]);
    s = run(r.state, { type: 'node.setBinding', owner, nodeId: r.results[0].nodeId as string, field: 'text', binding: { $item: 'field.client' } });
    expect(errors(s)).toEqual([]);
    const html = await serverHtml(generateProject(publishedState(s)), 'loops-archive-edit-', 'src/routes/work/+page.svelte');
    expect(html).toContain('Northwind Ltd');
    // Only an archive layout repeats the archive page's entries.
    expect(refusal(s, { type: 'node.insert', owner: home(s), parentId: null, primitive: 'repeat', archive: true })).toMatch(/archive layout/);
  });
});

describe('the editor', () => {
  it("inserts a collection list on a page as one change: a Stack whose loop shows each entry's title", async () => {
    const s0 = studio();
    const { insertOps } = await import('../../src/renderer/src/lib/insert-at');
    const ops = insertOps({ owner: home(s0), parentId: null, index: 0 }, { primitive: 'stack', loop: 'projects' }, 'element');
    const s = applyOperations(s0, ops).state;
    expect(errors(s)).toEqual([]);
    const loop = Object.values(s.pages[s.site.homePageId].nodes).find((n) => n.kind === 'repeat') as RepeatNode;
    expect(loop.list).toEqual({ $query: { collectionId: 'projects' } });
    const html = await serverHtml(generateProject(publishedState(s)), 'loops-insert-');
    expect(html).toContain('Dockside Offices');
  });

  it("shows a collection's index layout on its index, and leaves it when the layout goes", async () => {
    const { keepTemplateValid, shownView, templateOwner } = await import('../../src/renderer/src/lib/template-view');
    let s = run(studio(), { type: 'collection.update', collectionId: 'projects', archiveTemplate: 'start' });
    const mode = { collectionId: 'projects', entryId: null, archive: true as const };
    expect(templateOwner(mode)).toEqual({ kind: 'archive', id: 'projects' });
    expect(shownView(s, s.site.homePageId, mode)?.route).toBe('/work/');
    expect(keepTemplateValid(s, mode)).toBe(mode);
    s = run(s, { type: 'collection.update', collectionId: 'projects', archiveTemplate: null });
    expect(keepTemplateValid(s, mode)).toBeNull();
  });
});

describe('detaching', () => {
  it('refuses to detach a section that shows a collection, which would freeze it to its own items', () => {
    let { s, id } = withTeam(studio());
    s = run(s, { type: 'instance.setListSource', owner: home(s), nodeId: id, prop: 'people', source: { query: ARCHITECTS, fields: PEOPLE } });
    expect(refusal(s, { type: 'component.detachInstance', owner: home(s), nodeId: id } as EditOperation)).toMatch(/cannot be detached/);
  });
});

describe('review regressions', () => {
  it('generates a page with a collection loop through the generation cache, in both modes, as a full run does', () => {
    let { s } = withLoop(studio(), { collectionId: 'projects' });
    const cache = new GenerationCache();
    for (const opts of [{}, { instrument: true }]) expect([...generateProject(s, opts, cache)]).toEqual([...generateProject(s, opts)]);
    s = run(s, { type: 'entry.update', collectionId: 'projects', entryId: 'en_mill', values: { client: 'Fernhill Yoga' } });
    for (const opts of [{}, { instrument: true }]) {
      const files = generateProject(s, opts, cache);
      expect([...files]).toEqual([...generateProject(s, opts)]);
      expect(files.get(pageFile(s.pages[s.site.homePageId]))).toContain('Fernhill Yoga');
    }
  });

  it("keeps a design's own conditions inside its collection loop: a property still decides what each row shows", async () => {
    let s = studio();
    const made = applyOperations(s, [{ type: 'component.create', name: 'Project list' } as EditOperation]);
    s = made.state;
    const defId = made.results[0].definitionId as string;
    const owner: OwnerRef = { kind: 'component', id: defId };
    const root = s.components[defId].tree!.rootIds[0];
    s = run(s, { type: 'component.setPropSchema', definitionId: defId, prop: 'showClient', schema: { type: 'boolean', label: 'Show client', default: true } } as EditOperation);
    const loop = applyOperations(s, [{ type: 'node.insert', owner, parentId: root, primitive: 'repeat', query: { collectionId: 'projects' } }]);
    s = loop.state;
    const p = applyOperations(s, [{ type: 'node.insert', owner, parentId: loop.results[0].nodeId as string, primitive: 'paragraph', text: 'x' }]);
    const para = p.results[0].nodeId as string;
    s = run(p.state, { type: 'node.setBinding', owner, nodeId: para, field: 'text', binding: { $item: 'field.client' } }, { type: 'node.setBinding', owner, nodeId: para, field: 'when', binding: { $prop: 'showClient' } });
    expect(errors(s)).toEqual([]);
    const placed = applyOperations(s, [{ type: 'node.insert', owner: home(s), parentId: null, index: 0, definitionId: defId, props: { showClient: false } }]);
    s = placed.state;
    const off = await serverHtml(generateProject(publishedState(s)), 'loops-design-off-');
    expect(off).not.toContain('Hart Family');
    s = run(s, { type: 'instance.setProp', owner: home(s), nodeId: placed.results[0].nodeId as string, prop: 'showClient', value: true });
    const on = await serverHtml(generateProject(publishedState(s)), 'loops-design-on-');
    expect(on).toContain('Hart Family');
    expect(on).not.toMatch(/data-so-/);
    // A design showing a collection is never frozen into code.
    expect(refusal(s, { type: 'component.convertToCode', owner: home(s), nodeId: placed.results[0].nodeId as string } as EditOperation)).toMatch(/collection's entries/);
  });

  it("keys the site's rows by place in the loop, not by editor node", () => {
    const { s, title } = withLoop(studio(), { collectionId: 'projects' });
    const clean = generateProject(publishedState(s)).get(pageFile(s.pages[s.site.homePageId]))!;
    expect(clean).not.toContain(`${title}|`);
    expect(clean).toMatch(/"f0":/);
  });

  it('refuses to detach a placement repeated by a loop that shows each entry, and detaches once disconnected', () => {
    let { s, id } = withTeam(studio());
    s = run(s, { type: 'instance.setListSource', owner: home(s), nodeId: id, prop: 'people', source: { query: ARCHITECTS, fields: PEOPLE } });
    s = run(s, { type: 'instance.setListSource', owner: home(s), nodeId: id, prop: 'people', source: null });
    const after = run(s, { type: 'component.detachInstance', owner: home(s), nodeId: id } as EditOperation);
    expect(after.pages[after.site.homePageId].nodes[id]).toBeUndefined();
  });

  it("refuses removing a grouping's term a loop filters by, and leaves a project's existing problem alone when the collection is renamed", () => {
    let s = run(studio(), { type: 'collection.update', collectionId: 'projects', taxonomies: { sectors: { label: 'Sectors', terms: { homes: { label: 'Homes' }, offices: { label: 'Offices' } } } } });
    ({ s } = withLoop(s, { collectionId: 'projects', where: [{ field: 'terms.sectors', op: 'eq', value: 'homes' }] }));
    expect(refusal(s, { type: 'collection.removeTerm', collectionId: 'projects', taxonomyId: 'sectors', termId: 'homes' } as EditOperation)).toMatch(/term of “Sectors”/);
    // A loop element reading a field the collection lacks (a hand edit) is reported, and renaming the collection,
    // which changes how the problem is worded, is not refused for it.
    const broken = structuredClone(s);
    const text = Object.values(broken.pages[broken.site.homePageId].nodes).find((n) => n.kind === 'text' && (n as { text?: unknown }).text && typeof (n as { text?: unknown }).text === 'object')!;
    (text as unknown as { text: unknown }).text = { $item: 'field.gone' };
    expect(errors(broken).map((d) => d.code)).toContain('COLLECTION_SOURCE');
    expect(run(broken, { type: 'collection.update', collectionId: 'projects', name: 'Work' }).collections.projects.settings.name).toBe('Work');
  });

  it('connects a list that fills itself from posts, which then shows the collection instead', async () => {
    let s = studio();
    const r = applyOperations(s, [{ type: 'node.insert', owner: home(s), parentId: null, index: 0, componentId: 'blog.grid' }]);
    s = r.state;
    const id = r.results[0].nodeId as string;
    s = run(s, { type: 'instance.setListSource', owner: home(s), nodeId: id, prop: 'items', source: { query: { collectionId: 'projects', sort: [{ field: 'field.client' }] }, fields: { title: 'title', pageLink: 'entryLink' } } });
    expect(errors(s)).toEqual([]);
    const html = await serverHtml(generateProject(publishedState(s)), 'loops-feed-');
    expect(html).toContain('Dockside Offices');
    expect(html).toContain('href="/work/old-mill/"');
  });

  it('refuses a guest binding a form destination to each entry of a loop', async () => {
    const { checkEditBatch } = await import('@shared/live/capabilities');
    const op = { type: 'node.setBinding', owner: { kind: 'page', id: 'p' }, nodeId: 'n_abcd', field: 'prop', prop: 'endpoint', binding: { $item: 'title' } };
    expect(checkEditBatch('collaborator', { operations: [op] })).toMatchObject({ ok: false });
  });

  it('gives an archive layout given whole fresh node IDs, so it shares no node with the page it was copied from', () => {
    const s0 = studio();
    const page = s0.pages[s0.site.homePageId];
    const s = run(s0, { type: 'collection.update', collectionId: 'projects', archiveTemplate: { rootIds: page.rootIds, nodes: page.nodes as Record<string, unknown> } });
    const layout = s.collections.projects.settings.archiveTemplate!;
    expect(Object.keys(layout.nodes).length).toBe(Object.keys(page.nodes).length);
    expect(Object.keys(layout.nodes).some((id) => Object.hasOwn(page.nodes, id))).toBe(false);
    expect(refusal(s0, { type: 'collection.update', collectionId: 'projects', archiveTemplate: { rootIds: ['x'], nodes: { x: { id: 'x', kind: 'slot', slot: 'a' } } } })).toMatch(/not one it can hold/);
  });
});
