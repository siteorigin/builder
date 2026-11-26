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
    expect(files.get(pageFile(s.pages[s.site.homePageId]))).not.toMatch(/collectionId|\$query/);
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
    // An entry that starts matching joins the list.
    s = run(s, { type: 'entry.update', collectionId: 'team', entryId: 'en_okafor', values: { role: 'Architect' } });
    expect(generateProject(s, {}, cache).get(file)).toContain('Ben Okafor');
  });

  it('refuses a connection that cannot show: a field items lack, an entry field the collection lacks, a kind that does not fit, an item field left unfilled', () => {
    const { s, id } = withTeam(studio());
    const connect = (fields: Record<string, string>, query: Record<string, unknown> = ARCHITECTS) => refusal(s, { type: 'instance.setListSource', owner: home(s), nodeId: id, prop: 'people', source: { query, fields } });
    expect(connect({ ...PEOPLE, shoe: 'title' })).toMatch(/fills "shoe"/);
    expect(connect({ ...PEOPLE, role: 'field.salary' })).toMatch(/do not have/);
    expect(connect({ ...PEOPLE, portrait: 'title' })).toMatch(/cannot fill/);
    expect(connect({ role: 'field.role' })).toMatch(/unfilled/);
    expect(connect(PEOPLE, { collectionId: 'staff' })).toMatch(/does not have/);
    expect(connect(PEOPLE, { collectionId: '$current' })).toMatch(/collection of the page it is on/);
    expect(connect(PEOPLE, { collectionId: 'team', where: [{ field: 'field.salary', op: 'eq', value: 1 }] })).toMatch(/filters by "field.salary"/);
  });

  it('refuses a change elsewhere that would break it: the collection removed, a field it shows retyped', () => {
    let { s, id } = withTeam(studio());
    s = run(s, { type: 'instance.setListSource', owner: home(s), nodeId: id, prop: 'people', source: { query: ARCHITECTS, fields: PEOPLE } });
    expect(refusal(s, { type: 'collection.remove', collectionId: 'team' })).toMatch(/does not have/);
    expect(refusal(s, { type: 'collection.update', collectionId: 'team', fields: { role: { type: 'number', label: 'Role' }, location: { type: 'string', label: 'Location' }, senior: { type: 'boolean', label: 'Senior' } } })).toMatch(/Role/);
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
    expect(refusal(s, { type: 'collection.remove', collectionId: 'projects' })).toBeTruthy();
  });

  it("in a collection's layout, lists the collection's other entries", async () => {
    let s = studio();
    const owner: OwnerRef = { kind: 'template', id: 'projects' };
    ({ s } = withLoop(s, { collectionId: '$current', excludeCurrent: true }, owner));
    expect(errors(s)).toEqual([]);
    const files = generateProject(publishedState(s));
    const mill = files.get('src/routes/work/old-mill/+page.svelte')!;
    expect(mill).toContain('Dockside Offices');
    expect(mill).not.toMatch(/"The Old Mill"[^\n]*"id":"en_mill"/);
    expect(mill).not.toContain('"id":"en_mill"');
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
