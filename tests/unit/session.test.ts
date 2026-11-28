import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstanceNode, ProjectState, TextNode } from '@shared/types';
import { listPropFor, shownValue } from '../../src/renderer/src/lib/model';
import { createStarterState } from '@catalogue/starters';
import { P } from '@catalogue/dsl';
import { makeInstance } from '@engine/install';
import { projectDesign } from './fixtures/packs';
import { ProjectSession } from '../../src/main/project/session';
import { sha } from '../../src/main/project/fsutil';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
async function make(start = createStarterState('business', 'Persist', false)) {
  const dir = mkdtempSync(join(tmpdir(), 'so-session-'));
  dirs.push(dir);
  const s = await ProjectSession.create(dir, start);
  return { dir, s };
}

/**
 * A grid of cards built in the editor, the project's own design: Foundation's sections are code components, which
 * have no design tree to edit and take no anchor. Each card has an icon in a badge and a title from its list item.
 */
function cardGrid(state: ProjectState) {
  return projectDesign(state, {
    componentId: 'test.cards',
    name: 'Cards',
    properties: {
      heading: P.str('Heading', 'What we offer'),
      items: P.list('Cards', 'Card', { icon: P.icon('Icon', 'star'), title: P.str('Title', 'Card') }, [
        { icon: 'star', title: 'Planning' },
        { icon: 'pencil', title: 'Design' },
        { icon: 'hammer', title: 'Building' }
      ])
    },
    parts: { root: { nodeId: 'root', label: 'Section', styleControls: [] }, cardTitle: { nodeId: 'card-title', label: 'Card title', styleControls: [] } },
    build: (b) =>
      b.el('root', 'section', { name: 'Section' }, [
        b.text('heading', 'h2', { $prop: 'heading' }, { name: 'Heading' }),
        b.el('grid', 'ul', { name: 'Card grid' }, [
          b.repeat('cards', 'items', [
            b.el('card', 'li', { name: 'Card' }, [
              b.el('card-icon-wrap', 'div', { name: 'Icon badge' }, [b.icon('card-icon', { $item: 'icon' }, { name: 'Icon' })]),
              b.text('card-title', 'h3', { $item: 'title' }, { name: 'Title' })
            ])
          ])
        ])
      ])
  });
}

/** The starter with a placement of the card grid put at `index` among `pageId`'s sections (Home by default). */
function startWithCards(index: number, pageId?: (s: ProjectState) => string) {
  const start = createStarterState('business', 'Persist', false);
  const page = start.pages[pageId?.(start) ?? start.site.homePageId];
  const placed = makeInstance(cardGrid(start));
  page.nodes[placed.id] = placed;
  page.rootIds.splice(index, 0, placed.id);
  return { start, placed };
}

describe('project session', () => {
  it('saves an edit of a repeated item a placement shows from its design’s defaults, and keeps it on reopen (#138)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-session-'));
    dirs.push(dir);
    const { start, placed: grid } = startWithCards(1);
    const homeId = start.site.homePageId;
    const def = start.components[grid.definitionId];
    const list = listPropFor(def, 'card-title')!;
    // The placement has no list of its own: the page shows the design's default items.
    delete grid.props[list];
    const s = await ProjectSession.create(dir, start);
    expect(Object.hasOwn((s.state.pages[homeId].nodes[grid.id] as InstanceNode).props, list)).toBe(false);
    const items = (def.properties[list] as { default: Array<{ id: string } & Record<string, unknown>> }).default;
    const owner = { kind: 'page' as const, id: homeId };
    const ref = { owner, instancePath: [grid.id], nodeId: 'card-title', itemPath: [items[1].id] };
    const bound = (def.tree!.nodes['card-title'] as TextNode).text as { $item: string };
    expect(shownValue(s.state, ref, bound)).toBe(items[1][bound.$item]);
    // What committing the text typed on the canvas applies.
    const r = await s.apply({ operations: [{ type: 'instance.setProp', owner, nodeId: grid.id, prop: list, itemId: items[1].id, field: bound.$item, value: 'Changed on the page' }] }, { label: 'Edit text' });
    expect(r.ok).toBe(true);
    await s.close();
    const again = await ProjectSession.open(dir, 'test');
    const placed = again.state.pages[homeId].nodes[grid.id] as InstanceNode;
    // The placement now holds its own copy of the items, with their IDs, and the edited one changed.
    expect((placed.props[list] as Array<{ id: string }>).map((i) => i.id)).toEqual(items.map((i) => i.id));
    expect(shownValue(again.state, ref, bound)).toBe('Changed on the page');
    expect(shownValue(again.state, { ...ref, itemPath: [items[0].id] }, bound)).toBe(items[0][bound.$item]);
    // The design's own items are untouched.
    expect((again.state.components[def.id].properties[list] as { default: unknown }).default).toEqual(items);
    await again.close();
  });

  it('persists edits and history across reopen (P02)', async () => {
    const { dir, s } = await make();
    await s.apply({ operations: [{ type: 'site.update', name: 'Renamed' }] }, { label: 'Rename site' });
    await s.close();
    const again = await ProjectSession.open(dir, 'test');
    expect(again.state.site.name).toBe('Renamed');
    expect(again.historyInfo().canUndo).toBe(true);
    await again.undo();
    expect(again.state.site.name).toBe('Persist');
    expect(JSON.parse(readFileSync(join(dir, 'siteorigin/site.json'), 'utf8')).name).toBe('Persist');
  });

  it('undoes definition and token operations like any other edit', async () => {
    const { s } = await make();
    const r = await s.apply({ operations: [{ type: 'token.create', group: 'color', label: 'Teal', value: '#008080' }] }, { label: 'Add style' });
    expect(r.ok).toBe(true);
    expect(s.state.tokens.custom).toHaveLength(1);
    await s.undo();
    expect(s.state.tokens.custom).toHaveLength(0);
    await s.redo();
    expect(s.state.tokens.custom[0].id).toBe('color.custom-teal');
  });

  it('undoes and redoes a visibility rule and "hide when empty" on a component’s design, step by step (#368)', async () => {
    const { start, placed } = startWithCards(1);
    const { s } = await make(start);
    const homeId = s.state.site.homePageId;
    // The project's own design, edited everywhere it is placed.
    const defId = placed.definitionId;
    const owner = { kind: 'component' as const, id: defId };
    /** What the design and the placement hold: the badge's flag, the icon's rule, and the placement's heading. */
    const now = () => {
      const nodes = s.state.components[defId].tree!.nodes;
      // Absent, not set to false or null: a restored design is the one saved before.
      return { collapse: 'collapseEmpty' in nodes['card-icon-wrap'] ? (nodes['card-icon-wrap'] as { collapseEmpty?: boolean }).collapseEmpty : 'absent', when: 'when' in nodes['card-icon'] ? nodes['card-icon'].when : 'absent', heading: (s.state.pages[homeId].nodes[placed.id] as InstanceNode).props.heading };
    };
    const heading = now().heading;
    const rule = { ref: { $item: 'icon' }, ne: 'star' };
    expect((await s.apply({ operations: [{ type: 'node.setContent', owner, nodeId: 'card-icon-wrap', field: 'collapseEmpty', value: true }] }, { label: 'Hide empty container' })).ok).toBe(true);
    // A page edit between the two design edits: each step restores its own document and leaves the others alone.
    expect((await s.apply({ operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: homeId }, nodeId: placed.id, prop: 'heading', value: 'What we do' }] }, { label: 'Edit heading' })).ok).toBe(true);
    expect((await s.apply({ operations: [{ type: 'node.setBinding', owner, nodeId: 'card-icon', field: 'when', binding: { $item: 'icon' }, ne: 'star' }] }, { label: 'Set show condition' })).ok).toBe(true);
    const steps = [
      { collapse: true, when: rule, heading: 'What we do' },
      { collapse: true, when: 'absent', heading: 'What we do' },
      { collapse: true, when: 'absent', heading },
      { collapse: 'absent', when: 'absent', heading }
    ];
    expect(now()).toEqual(steps[0]);
    for (const expected of steps.slice(1)) {
      expect((await s.undo()).ok).toBe(true);
      expect(now()).toEqual(expected);
    }
    for (const expected of steps.slice(0, -1).reverse()) {
      expect((await s.redo()).ok).toBe(true);
      expect(now()).toEqual(expected);
    }
  });

  it('writes, undoes and reopens an old address kept working, and gives its route back to a page (#37)', async () => {
    const { dir, s } = await make();
    // The website was exported as it is: its pages' addresses are kept working when they move (#890).
    expect(await s.recordPublished(s.state)).toBeNull();
    const [homeId, aboutId] = s.state.site.pageOrder;
    const aboutFile = join(dir, 'src/routes/about/+page.svelte');
    const redirects = (f: string) => readFileSync(f, 'utf8').includes('http-equiv="refresh"');
    const r = await s.apply({ operations: [{ type: 'page.setHome', pageId: aboutId }] }, { label: 'Change home page' });
    expect(r.ok).toBe(true);
    expect(readFileSync(aboutFile, 'utf8')).toContain('const to = resolve("/");');
    expect(redirects(join(dir, 'src/routes/home/+page.svelte'))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 'siteorigin/site.json'), 'utf8')).redirects).toEqual([{ from: '/about/', pageId: aboutId }]);
    await s.undo();
    expect(redirects(aboutFile)).toBe(false);
    expect(existsSync(join(dir, 'src/routes/home'))).toBe(false);
    expect(s.state.site.redirects).toBeUndefined();
    await s.redo();
    expect(redirects(aboutFile)).toBe(true);
    await s.close();
    const again = await ProjectSession.open(dir, 'test');
    expect(again.state.site.redirects).toEqual([{ from: '/about/', pageId: aboutId }]);
    // Exported again, with Home at /home/.
    expect(await again.recordPublished(again.state)).toBeNull();
    // Home again: About takes /about/ back, and the page replaces the redirect in the same file.
    await again.apply({ operations: [{ type: 'page.setHome', pageId: homeId }] }, { label: 'Change home page' });
    expect(redirects(aboutFile)).toBe(false);
    expect(readFileSync(aboutFile, 'utf8')).toContain('A small studio with a long view');
    expect(readFileSync(join(dir, 'src/routes/home/+page.svelte'), 'utf8')).toContain('const to = resolve("/");');
    // Declining to keep the address writes none; Home takes its own /home/ back.
    await again.apply({ operations: [{ type: 'page.setHome', pageId: aboutId, keepOldAddress: false }] }, { label: 'Change home page' });
    expect(again.state.site.redirects).toBeUndefined();
    expect(redirects(join(dir, 'src/routes/home/+page.svelte'))).toBe(false);
    expect(existsSync(aboutFile)).toBe(false);
    await again.close();
  });

  it('refuses an undo that would put a page on an address changed outside the app (#37)', async () => {
    const { dir, s } = await make();
    // The website was exported as it is: its pages' addresses are kept working when they move (#890).
    expect(await s.recordPublished(s.state)).toBeNull();
    const [, aboutId, contactId] = s.state.site.pageOrder;
    await s.apply({ operations: [{ type: 'page.update', pageId: contactId, route: '/sales/' }] }, { label: 'Move Contact' });
    await s.close();
    const sitePath = join(dir, 'siteorigin/site.json');
    const site = JSON.parse(readFileSync(sitePath, 'utf8'));
    writeFileSync(sitePath, JSON.stringify({ ...site, redirects: [{ from: '/contact/', pageId: aboutId }] }, null, 2) + '\n');
    const again = await ProjectSession.open(dir, 'test');
    const r = await again.undo();
    expect(r.ok).toBe(false);
    // The move kept /contact/ working for Contact in site.json (#169), so the outside edit changed a document the
    // undo restores, and it is refused before anything else is checked.
    expect(r.error?.message).toMatch(/Cannot undo "Move Contact" because siteorigin\/site\.json has changed since/);
    expect(again.state.pages[contactId].route).toBe('/sales/');
    expect(again.state.site.redirects).toEqual([{ from: '/contact/', pageId: aboutId }]);
    await again.close();
    // The project still opens.
    await (await ProjectSession.open(dir, 'test')).close();
  });

  it('refuses a redo that would put a page on an address taken outside the app (#37)', async () => {
    const { dir, s } = await make();
    const [, aboutId, contactId] = s.state.site.pageOrder;
    await s.apply({ operations: [{ type: 'page.update', pageId: contactId, route: '/sales/' }] }, { label: 'Move Contact' });
    expect((await s.undo()).ok).toBe(true);
    await s.close();
    // About moved to /sales/ by hand: a document the redo does not restore.
    const aboutPath = join(dir, `siteorigin/pages/${aboutId}.json`);
    writeFileSync(aboutPath, JSON.stringify({ ...JSON.parse(readFileSync(aboutPath, 'utf8')), route: '/sales/' }, null, 2) + '\n');
    const again = await ProjectSession.open(dir, 'test');
    const r = await again.redo();
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/Cannot redo "Move Contact": .*\/sales\//);
    expect(again.state.pages[contactId].route).toBe('/contact/');
    expect(again.state.pages[aboutId].route).toBe('/sales/');
    await again.close();
  });

  it('waits for an outside edit the project has not loaded yet before undoing (#37)', async () => {
    const { dir, s } = await make();
    // The website was exported as it is: its pages' addresses are kept working when they move (#890).
    expect(await s.recordPublished(s.state)).toBeNull();
    const [, aboutId, contactId] = s.state.site.pageOrder;
    await s.apply({ operations: [{ type: 'page.update', pageId: contactId, route: '/sales/' }] }, { label: 'Move Contact' });
    // Written while the project is open, before anything reloads it.
    const sitePath = join(dir, 'siteorigin/site.json');
    const site = JSON.parse(readFileSync(sitePath, 'utf8'));
    writeFileSync(sitePath, JSON.stringify({ ...site, redirects: [{ from: '/contact/', pageId: aboutId }] }, null, 2) + '\n');
    const r = await s.undo();
    expect(r.ok).toBe(false);
    // The move wrote site.json too (#169): the undo meets the outside edit as it writes, and keeps it.
    expect(r.error?.message).toMatch(/siteorigin\/site\.json was changed outside SiteOrigin Builder/);
    expect(JSON.parse(readFileSync(sitePath, 'utf8')).redirects).toEqual([{ from: '/contact/', pageId: aboutId }]);
    expect(JSON.parse(readFileSync(join(dir, `siteorigin/pages/${contactId}.json`), 'utf8')).route).toBe('/sales/');
    // A page file added outside the app counts too.
    writeFileSync(sitePath, JSON.stringify(site, null, 2) + '\n');
    writeFileSync(join(dir, 'siteorigin/pages/pg_outside.json'), readFileSync(join(dir, `siteorigin/pages/${aboutId}.json`), 'utf8'));
    expect((await s.undo()).error?.message).toMatch(/pg_outside\.json changed outside the app/);
    rmSync(join(dir, 'siteorigin/pages/pg_outside.json'));
    expect((await s.undo()).ok).toBe(true);
    expect(s.state.pages[contactId].route).toBe('/contact/');
    await s.close();
  });

  it('refuses to open a project whose old addresses are damaged or go nowhere (#37)', async () => {
    const { dir, s } = await make();
    await s.close();
    const sitePath = join(dir, 'siteorigin/site.json');
    const site = JSON.parse(readFileSync(sitePath, 'utf8'));
    for (const [redirects, message] of [
      [{ from: '/x/' }, /old page addresses is damaged/],
      [[{ from: '/x/' }], /An old page address is damaged/],
      [[{ from: '/x/', pageId: 'pg_missing' }], /goes to a page that no longer exists/]
    ] as const) {
      writeFileSync(sitePath, JSON.stringify({ ...site, redirects }, null, 2) + '\n');
      await expect(ProjectSession.open(dir, 'test')).rejects.toThrow(message);
    }
  });

  it('rejects stale revisions', async () => {
    const { s } = await make();
    const r = await s.apply({ expectedRevision: 42, operations: [{ type: 'site.update', name: 'x' }] }, { label: 'x' });
    expect(r.error?.code).toBe('STALE_REVISION');
  });

  it('never replaces a document saved outside the app after the save checked it, and carries on (#82)', async () => {
    const { dir, s } = await make();
    const home = s.state.site.homePageId;
    const file = join(dir, 'siteorigin', 'pages', `${home}.json`);
    // Another editor saves the page while the change's journal is being written: after the check, before the write.
    const session = s as unknown as { placeJournal: (...a: unknown[]) => Promise<void> };
    const placeJournal = session.placeJournal.bind(s);
    session.placeJournal = async (...a) => {
      await placeJournal(...a);
      session.placeJournal = placeJournal;
      const page = JSON.parse(readFileSync(file, 'utf8'));
      page.title = 'Saved in another editor';
      writeFileSync(file, JSON.stringify(page, null, 2) + '\n');
    };
    const r = await s.apply({ operations: [{ type: 'page.update', pageId: home, description: 'Typed' }] }, { label: 'Change description' });
    expect(r).toMatchObject({ ok: false, error: { code: 'CONFLICT', recoverable: true } });
    expect(JSON.parse(readFileSync(file, 'utf8')).title).toBe('Saved in another editor');
    // A change stopped cleanly by a file saved outside the app is a conflict, not a failed save (#753).
    expect(s.saveFailure).toBeNull();
    // Nothing of the change reached disk, so nothing waits on a reopen: the external save is read, and edits go on.
    expect(existsSync(join(dir, '.siteorigin', 'journal.json'))).toBe(false);
    expect((await s.reloadFromDisk()).ok).toBe(true);
    expect((await s.apply({ operations: [{ type: 'page.update', pageId: home, description: 'Typed' }] }, { label: 'Change description' })).ok).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ title: 'Saved in another editor', seo: { description: 'Typed' } });
  });

  it('says a save stopped part way by a file saved outside the app needs the project reopened', async () => {
    const { dir, s } = await make();
    const [home, about] = s.state.site.pageOrder;
    const session = s as unknown as { placeJournal: (j: { writes: Array<{ path: string }> }, ...rest: unknown[]) => Promise<void> };
    const placeJournal = session.placeJournal.bind(s);
    session.placeJournal = async (j, ...rest) => {
      await placeJournal(j, ...rest);
      session.placeJournal = placeJournal;
      // The second document of the batch is saved outside the app; the first is replaced before that is seen.
      const second = join(dir, j.writes[1].path);
      const doc = JSON.parse(readFileSync(second, 'utf8'));
      doc.title = 'Saved in another editor';
      writeFileSync(second, JSON.stringify(doc, null, 2) + '\n');
    };
    const r = await s.apply(
      { operations: [{ type: 'page.update', pageId: home, description: 'One' }, { type: 'page.update', pageId: about, description: 'Two' }] },
      { label: 'Two pages' }
    );
    // Said of this save, which reopening finishes: the editor keeps the typed text only to copy (#1435).
    expect(r).toMatchObject({ ok: false, error: { code: 'CONFLICT', recoverable: false, message: expect.stringMatching(/while this change was being saved.*reopen/), details: { save: 'unfinished' } } });
    // The journal stays for reopening to finish.
    expect(existsSync(join(dir, '.siteorigin', 'journal.json'))).toBe(true);
    // The save indicator shows it until the project is reopened (#753).
    expect(s.saveFailure).toEqual({ kind: 'unfinished', label: 'Two pages', message: expect.stringMatching(/reopen/) });
  });

  it('keeps a save that failed to write for the save indicator until a later save succeeds (#753)', async () => {
    const { s } = await make();
    const home = s.state.site.homePageId;
    const failed: number[] = [];
    s.on('save-failed', () => failed.push(s.revision));
    // The change's versions and journal cannot be written: nothing of it takes its place.
    const session = s as unknown as { placeJournal: (...a: unknown[]) => Promise<void> };
    const placeJournal = session.placeJournal.bind(s);
    session.placeJournal = async () => {
      session.placeJournal = placeJournal;
      throw new Error('ENOSPC: no space left on device');
    };
    const revision = s.revision;
    await expect(s.apply({ operations: [{ type: 'page.update', pageId: home, description: 'Lost' }] }, { label: 'Change description' })).rejects.toThrow(/ENOSPC/);
    // Said at once, at the revision it failed at: nothing of it was written.
    expect(failed).toEqual([revision]);
    expect(s.saveFailure).toEqual({ kind: 'failed', label: 'Change description', message: 'ENOSPC: no space left on device' });
    expect(s.saveUnfinished).toBe(false);
    // A refused edit saves nothing, so the failure still stands.
    const refused = await s.apply({ operations: [{ type: 'page.update', pageId: 'no-such-page', description: 'x' }] }, { label: 'Nothing' });
    expect(refused.ok).toBe(false);
    expect(s.saveFailure?.kind).toBe('failed');
    // The next save that reaches the disk clears it.
    expect((await s.apply({ operations: [{ type: 'page.update', pageId: home, description: 'Saved' }] }, { label: 'Change description' })).ok).toBe(true);
    expect(s.saveFailure).toBeNull();
  });

  it('announces an edit once it is committed, before its History and revision take their places (#962)', async () => {
    const { dir, s } = await make();
    const home = s.state.site.homePageId;
    const file = join(dir, 'siteorigin', 'pages', `${home}.json`);
    const journal = join(dir, '.siteorigin', 'journal.json');
    const state = join(dir, '.siteorigin', 'state.json');
    const revision = s.revision;
    const heard: Array<{ journal: boolean; saved: unknown; revision: unknown; undo: unknown }> = [];
    s.on('changed', () => heard.push({ journal: existsSync(journal), saved: JSON.parse(readFileSync(file, 'utf8')).seo?.description, revision: JSON.parse(readFileSync(state, 'utf8')).revision, undo: s.historyInfo().undoLabel }));
    expect((await s.apply({ operations: [{ type: 'page.update', pageId: home, description: 'Heard' }] }, { label: 'Heard' })).ok).toBe(true);
    // Heard with the document saved and the journal that would finish the rest after a crash still in place, and with
    // History already showing the step, before the revision reached the disk.
    expect(heard).toEqual([{ journal: true, saved: 'Heard', revision, undo: 'Heard' }]);
    // Then the rest is done before the edit returns.
    expect(existsSync(journal)).toBe(false);
    expect(JSON.parse(readFileSync(state, 'utf8')).revision).toBe(revision + 1);
  });

  it('announces a save with no journal only once its revision is on disk (#962)', async () => {
    const { dir, s } = await make();
    const state = join(dir, '.siteorigin', 'state.json');
    const revision = s.revision;
    const heard: unknown[] = [];
    s.on('changed', () => heard.push(JSON.parse(readFileSync(state, 'utf8')).revision));
    // The name it already has: no document changes and no History step, only the revision moves.
    expect((await s.apply({ operations: [{ type: 'site.update', name: s.state.site.name }] }, { label: 'Same name' })).ok).toBe(true);
    expect(s.revision).toBe(revision + 1);
    expect(heard).toEqual([revision + 1]);
  });

  it('stores a batch’s many new versions before its journal, which then carries none (#962)', async () => {
    const { dir, s } = await make();
    const blobs = join(dir, '.siteorigin', 'history', 'blobs');
    const session = s as unknown as { placeJournal: (j: { writes: Array<{ blob: string }>; versions?: object }, ...rest: unknown[]) => Promise<void> };
    const placeJournal = session.placeJournal.bind(s);
    const seen: Array<{ carried: number; stored: boolean }> = [];
    session.placeJournal = async (j, ...rest) => {
      seen.push({ carried: Object.keys(j.versions ?? {}).length, stored: j.writes.every((w) => existsSync(join(blobs, `${w.blob}.json`))) });
      return placeJournal(j, ...rest);
    };
    const pages = Array.from({ length: 70 }, (_, i) => ({ type: 'page.create' as const, title: `Page ${i + 1}` }));
    expect((await s.apply({ operations: pages }, { label: 'Many pages' })).ok).toBe(true);
    expect((await s.apply({ operations: [{ type: 'site.update', name: 'Few' }] }, { label: 'Few' })).ok).toBe(true);
    // The many are stored first; a small change carries its new versions in its journal.
    expect(seen[0]).toEqual({ carried: 0, stored: true });
    expect(seen[1].carried).toBeGreaterThan(0);
    expect((await s.undo()).ok).toBe(true);
    expect((await s.undo()).ok).toBe(true);
    expect(Object.keys(s.state.pages)).toHaveLength(Object.keys(createStarterState('business', 'Persist', false).pages).length);
  });

  it('preserves an externally edited generated file and reports a conflict (I02)', async () => {
    const { dir, s } = await make();
    const file = join(dir, 'src/routes/about/+page.svelte');
    writeFileSync(file, '<h1>Hand edited</h1>\n');
    const aboutId = s.state.site.pageOrder[1];
    await s.apply({ operations: [{ type: 'page.update', pageId: aboutId, title: 'About us' }] }, { label: 'Rename' });
    expect(readFileSync(file, 'utf8')).toBe('<h1>Hand edited</h1>\n');
    expect(s.conflicts.some((c) => c.path === 'src/routes/about/+page.svelte')).toBe(true);
    await s.restoreGeneratedFile('src/routes/about/+page.svelte');
    expect(readFileSync(file, 'utf8')).toContain('Generated by SiteOrigin Builder');
    expect(existsSync(join(dir, '.siteorigin/recovery'))).toBe(true);
  });

  it('finishes an interrupted publication from the journal before opening (A08)', async () => {
    const { dir, s } = await make();
    await s.close();
    // Simulate a crash after the journal was written but before files were replaced.
    const sitePath = join(dir, 'siteorigin/site.json');
    const beforeHash = sha(readFileSync(sitePath, 'utf8'));
    const site = JSON.parse(readFileSync(sitePath, 'utf8'));
    site.name = 'Recovered';
    const content = JSON.stringify(site, null, 2) + '\n';
    const blob = sha(content);
    writeFileSync(join(dir, '.siteorigin/history/blobs', `${blob}.json`), content);
    writeFileSync(join(dir, '.siteorigin/journal.json'), JSON.stringify({ writes: [{ path: 'siteorigin/site.json', blob, before: beforeHash }], deletes: [] }));
    const again = await ProjectSession.open(dir, 'test');
    expect(again.state.site.name).toBe('Recovered');
    expect(again.recoveryNotes.join(' ')).toMatch(/interrupted save/);
    expect(existsSync(join(dir, '.siteorigin/journal.json'))).toBe(false);
  });

  it('reverts an AI run that never completed when the project reopens', async () => {
    const { dir, s } = await make();
    await s.beginRun('run_x');
    await s.apply({ operations: [{ type: 'page.create', title: 'Half done' }] }, { label: 'AI', source: 'ai', runId: 'run_x', history: false });
    // Simulate a crash: no completion marker, process gone.
    await s.releaseLock();
    const again = await ProjectSession.open(dir, 'test');
    expect(Object.values(again.state.pages).some((p) => p.title === 'Half done')).toBe(false);
    expect(again.recoveryNotes.join(' ')).toMatch(/restored/);
  });

  it('never saves code that fails the safety checks', async () => {
    const { s } = await make();
    const r = await s.apply({ operations: [{ type: 'component.createCode', name: 'Bad', source: '<p>{broken</p>' }] }, { label: 'x' });
    expect(r.error?.code).toBe('VALIDATION_FAILED');
    expect(Object.values(s.state.components).some((d) => d.name === 'Bad')).toBe(false);
  });

  it('declares the parts and slots saved code shows, and refuses code that would hide content placed in a slot (#379)', async () => {
    const { s } = await make();
    const source = `<script>\n\tlet { so_o = undefined, slot_content = undefined } = $props();\n\t// let { slot_ghost } = $props();\n</script>\n\n<section><output class={so_o?.total} data-so-part="total">1</output>{@render slot_content?.()}</section>\n`;
    const made = await s.apply({ operations: [{ type: 'component.createCode', name: 'Calc', source }] }, { label: 'x' });
    expect(made.ok).toBe(true);
    const defId = made.results![0].definitionId as string;
    expect(s.state.components[defId].parts.total).toEqual({ nodeId: 'total', label: 'Total' });
    expect(s.state.components[defId].slots).toEqual({ content: { label: 'Content' } });
    const owner = { kind: 'page' as const, id: s.state.site.homePageId };
    const placed = await s.apply({ operations: [{ type: 'node.insert', owner, parentId: null, index: 0, definitionId: defId }] }, { label: 'x' });
    const calc = placed.results![0].nodeId as string;
    expect((await s.apply({ operations: [{ type: 'node.insert', owner, parentId: calc, slot: 'content', primitive: 'button', text: 'Go' }] }, { label: 'x' })).ok).toBe(true);
    const hidden = await s.apply({ operations: [{ type: 'component.updateSource', definitionId: defId, source: source.replace('{@render slot_content?.()}', '') }] }, { label: 'x' });
    expect(hidden.error?.code).toBe('VALIDATION_FAILED');
    expect(hidden.error?.message).toMatch(/“Content” slot holds content on the site/);
    expect(s.state.components[defId].source).toBe(source);
  });

  it('rejects path traversal for authored sources (I06)', async () => {
    const { s } = await make();
    const r = await s.apply({ operations: [{ type: 'component.createCode', name: 'X', source: '<p>x</p>' }] }, { label: 'x' });
    expect(r.ok).toBe(true);
    const { safeJoin } = await import('../../src/main/project/fsutil');
    expect(() => safeJoin(s.dir, '../outside.txt')).toThrow();
    expect(() => safeJoin(s.dir, '/etc/passwd')).toThrow();
  });
});

describe('assistant code that imports project components', () => {
  const FETCHES = `<script>\n\timport { onMount } from 'svelte';\n\tonMount(() => { fetch('/api'); });\n</script>\n<p>map</p>\n`;
  const importer = (path: string) => `<script>\n\timport Map from './${path.split('/').pop()}';\n</script>\n<Map />\n`;

  it('refuses an import that reaches code the assistant may not write', async () => {
    const { s } = await make();
    // A developer may write a component that fetches; the assistant may not reach it.
    const made = await s.apply({ operations: [{ type: 'component.createCode', name: 'Map', source: FETCHES }] }, { label: 'Create' });
    expect(made.ok).toBe(true);
    const path = s.state.components[made.results![0].definitionId as string].sourcePath!;
    const r = await s.apply({ operations: [{ type: 'component.createCode', name: 'Hero', source: importer(path) }] }, { label: 'AI', source: 'ai' });
    expect(r.error?.code).toBe('VALIDATION_FAILED');
    expect(r.error?.message).toMatch(/may not import ".*", which uses network requests/);
    expect(Object.values(s.state.components).some((d) => d.name === 'Hero')).toBe(false);
  });

  it('refuses the import in an edit to existing code, and an import of a component the same batch removes', async () => {
    const { s } = await make();
    const map = await s.apply({ operations: [{ type: 'component.createCode', name: 'Map', source: FETCHES }] }, { label: 'Create' });
    const mapId = map.results![0].definitionId as string;
    const path = s.state.components[mapId].sourcePath!;
    const hero = await s.apply({ operations: [{ type: 'component.createCode', name: 'Hero', source: '<p>hero</p>\n' }] }, { label: 'AI', source: 'ai' });
    const heroId = hero.results![0].definitionId as string;
    const edit = await s.apply({ operations: [{ type: 'component.updateSource', definitionId: heroId, source: importer(path) }] }, { label: 'AI', source: 'ai' });
    expect(edit.error?.code).toBe('VALIDATION_FAILED');
    expect(s.state.components[heroId].source).toBe('<p>hero</p>\n');
    const gone = await s.apply({ operations: [{ type: 'component.remove', definitionId: mapId }, { type: 'component.createCode', name: 'After', source: importer(path) }] }, { label: 'AI', source: 'ai' });
    expect(gone.error?.message).toMatch(/not a component in this project/);
  });

  it('checks the imported component as the batch leaves it, whichever order the batch changes it in', async () => {
    const { s } = await make();
    const made = await s.apply({ operations: [{ type: 'component.createCode', name: 'Map', source: FETCHES }] }, { label: 'Create' });
    const id = made.results![0].definitionId as string;
    const path = s.state.components[id].sourcePath!;
    const fixed = { type: 'component.updateSource' as const, definitionId: id, source: '<p>map</p>\n' };
    const create = (name: string) => ({ type: 'component.createCode' as const, name, source: importer(path) });
    expect((await s.apply({ operations: [create('Before'), fixed] }, { label: 'AI', source: 'ai' })).ok).toBe(true);
    await s.apply({ operations: [{ ...fixed, source: FETCHES }] }, { label: 'Developer' });
    expect((await s.apply({ operations: [fixed, create('After')] }, { label: 'AI', source: 'ai' })).ok).toBe(true);
  });
});

describe('code component history', () => {
  it('undoes and redoes edits to authored code component source', async () => {
    const { dir, s } = await make();
    const r = await s.apply({ operations: [{ type: 'component.createCode', name: 'Widget', source: '<p>one</p>\n' }] }, { label: 'Create' });
    const id = r.results![0].definitionId as string;
    const path = s.state.components[id].sourcePath!;
    await s.apply({ operations: [{ type: 'component.updateSource', definitionId: id, source: '<p>two</p>\n' }] }, { label: 'Edit source' });
    expect(readFileSync(join(dir, path), 'utf8')).toBe('<p>two</p>\n');
    await s.undo();
    expect(readFileSync(join(dir, path), 'utf8')).toBe('<p>one</p>\n');
    expect(s.state.components[id].source).toBe('<p>one</p>\n');
    await s.redo();
    expect(readFileSync(join(dir, path), 'utf8')).toBe('<p>two</p>\n');
    await s.undo();
    await s.undo();
    expect(s.state.components[id]).toBeUndefined();
    expect(existsSync(join(dir, path))).toBe(false);
  });
});

describe('review regressions', () => {
  it('ignores journal entries for non-canonical paths', async () => {
    const { dir, s } = await make();
    await s.close();
    writeFileSync(join(dir, 'vite.config.js'), '// original\n');
    const content = 'export default {}\n';
    const blob = sha(content);
    writeFileSync(join(dir, '.siteorigin/history/blobs', `${blob}.json`), content);
    writeFileSync(join(dir, '.siteorigin/journal.json'), JSON.stringify({ writes: [{ path: 'vite.config.js', blob, before: null }], deletes: [] }));
    const before = readFileSync(join(dir, 'vite.config.js'), 'utf8');
    const again = await ProjectSession.open(dir, 'test');
    expect(readFileSync(join(dir, 'vite.config.js'), 'utf8')).toBe(before);
    expect(again.recoveryNotes.join(' ')).toMatch(/set aside/);
  });

  it('crash recovery of an AI run leaves unrelated external edits alone', async () => {
    const { dir, s } = await make();
    await s.beginRun('run_y');
    await s.apply({ operations: [{ type: 'site.update', name: 'AI name' }] }, { label: 'AI', source: 'ai', runId: 'run_y', history: false });
    await s.releaseLock();
    const tokensPath = join(dir, 'siteorigin/tokens.json');
    const tokens = JSON.parse(readFileSync(tokensPath, 'utf8'));
    tokens.overrides['color.brand'] = '#123456';
    writeFileSync(tokensPath, JSON.stringify(tokens, null, 2) + '\n');
    const again = await ProjectSession.open(dir, 'test');
    expect(again.state.site.name).toBe('Persist');
    expect(again.state.tokens.overrides['color.brand']).toBe('#123456');
    // The cache matches disk, so the next edit and its undo behave.
    await again.apply({ operations: [{ type: 'site.update', name: 'Final' }] }, { label: 'x' });
    await again.undo();
    expect(again.state.site.name).toBe('Persist');
  });

  it('refuses to overwrite a newer on-disk edit', async () => {
    const { dir, s } = await make();
    await s.apply({ operations: [{ type: 'site.update', name: 'Mine' }] }, { label: 'x' });
    const sitePath = join(dir, 'siteorigin/site.json');
    const site = JSON.parse(readFileSync(sitePath, 'utf8'));
    site.description = 'External';
    writeFileSync(sitePath, JSON.stringify(site, null, 2) + '\n');
    const r = await s.undo();
    expect(r.error?.code).toBe('CONFLICT');
    expect(JSON.parse(readFileSync(sitePath, 'utf8')).description).toBe('External');
  });

  it('rejects late writes from a run that has ended', async () => {
    const { s } = await make();
    await s.beginRun('run_z');
    await s.abortRun();
    const r = await s.apply({ operations: [{ type: 'site.update', name: 'Late' }] }, { label: 'AI', source: 'ai', runId: 'run_z', history: false });
    expect(r.ok).toBe(false);
    expect(s.state.site.name).toBe('Persist');
  });

  it('lets only one opener hold the project', async () => {
    const { dir, s } = await make();
    await s.close();
    const a = await ProjectSession.open(dir, 'one');
    await expect(ProjectSession.open(dir, 'two')).rejects.toThrow(/already open/);
    await a.close();
    const b = await ProjectSession.open(dir, 'two');
    await b.close();
  });

  it('does not overwrite a hand-written file at a newly generated route', async () => {
    const { dir, s } = await make();
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'src/routes/team'), { recursive: true });
    writeFileSync(join(dir, 'src/routes/team/+page.svelte'), '<h1>Mine</h1>\n');
    await s.apply({ operations: [{ type: 'page.create', title: 'Team' }] }, { label: 'x' });
    expect(readFileSync(join(dir, 'src/routes/team/+page.svelte'), 'utf8')).toBe('<h1>Mine</h1>\n');
    expect(s.conflicts.some((c) => c.path === 'src/routes/team/+page.svelte')).toBe(true);
  });
});

describe('follow-up regressions', () => {
  it('does not report a conflict when a document was only reformatted', async () => {
    const { dir, s } = await make();
    const sitePath = join(dir, 'siteorigin/site.json');
    writeFileSync(sitePath, JSON.stringify(JSON.parse(readFileSync(sitePath, 'utf8'))));
    const r = await s.apply({ operations: [{ type: 'site.update', name: 'After reformat' }] }, { label: 'x' });
    expect(r.ok).toBe(true);
  });
});

describe('copy and paste (#62)', () => {
  const grid = (s: ProjectSession) => {
    const home = s.state.pages[s.state.site.homePageId];
    return home.rootIds.map((id) => home.nodes[id] as InstanceNode).find((n) => s.state.components[n.definitionId]?.componentId === 'features.grid')!;
  };
  const contact = (s: ProjectSession) => Object.values(s.state.pages).find((p) => p.title === 'Contact')!;

  it('pastes Services grid on Contact after the original was deleted, as one step undo takes back', async () => {
    const { s } = await make();
    const home = { kind: 'page' as const, id: s.state.site.homePageId };
    const original = grid(s);
    const c = await s.copy(home.id, original.id, s.revision);
    expect(c.ok).toBe(true);
    expect((await s.apply({ operations: [{ type: 'node.remove', owner: home, nodeId: original.id }] }, { label: 'Delete Services grid' })).ok).toBe(true);
    const before = contact(s).rootIds.length;
    const r = await s.apply({ operations: [{ type: 'node.paste', clipboardId: c.clipboardId!, toOwner: { kind: 'page', id: contact(s).id } }] }, { label: 'Paste Services grid', source: 'user' });
    expect(r.error?.message).toBeUndefined();
    const id = r.results![0].nodeId as string;
    const copy = contact(s).nodes[id] as InstanceNode;
    expect(contact(s).rootIds).toHaveLength(before + 1);
    expect(contact(s).rootIds).toContain(id);
    expect(copy.definitionId).toBe(original.definitionId);
    expect(copy.props.heading).toBe(original.props.heading);
    expect(s.state.pages[home.id].nodes[original.id]).toBeUndefined();
    // Undo and Redo say which documents they wrote and which step they took, so the editor can say so when that is
    // not the page it shows (#903).
    const contactDoc = `siteorigin/pages/${contact(s).id}.json`;
    expect(await s.undo()).toMatchObject({ ok: true, changed: [contactDoc], label: 'Paste Services grid' });
    expect(await s.redo()).toMatchObject({ ok: true, changed: [contactDoc], label: 'Paste Services grid' });
    await s.undo();
    expect(contact(s).rootIds).toHaveLength(before);
    expect(s.state.pages[home.id].nodes[original.id]).toBeUndefined();
    // The copy is still held: undoing the delete and pasting again works the same.
    await s.undo();
    expect(s.state.pages[home.id].nodes[original.id]).toBeDefined();
    const again = await s.apply({ operations: [{ type: 'node.paste', clipboardId: c.clipboardId!, toOwner: { kind: 'page', id: contact(s).id } }] }, { label: 'Paste', source: 'user' });
    expect(again.ok).toBe(true);
  });

  it('keeps a few recent copies, so a paste still finds the copy it followed', async () => {
    const { s } = await make();
    const home = s.state.pages[s.state.site.homePageId];
    const to = { kind: 'page' as const, id: contact(s).id };
    const first = await s.copy(home.id, grid(s).id, s.revision);
    const later = await s.copy(home.id, home.rootIds[0], s.revision);
    expect(later.clipboardId).not.toBe(first.clipboardId);
    const r = await s.apply({ operations: [{ type: 'node.paste', clipboardId: first.clipboardId!, toOwner: to }] }, { label: 'Paste', source: 'user' });
    expect((contact(s).nodes[r.results![0].nodeId as string] as InstanceNode).definitionId).toBe(grid(s).definitionId);
    for (let i = 0; i < 5; i++) await s.copy(home.id, home.rootIds[0], s.revision);
    const old = await s.apply({ operations: [{ type: 'node.paste', clipboardId: first.clipboardId!, toOwner: to }] }, { label: 'Paste', source: 'user' });
    expect(old.error?.message).toMatch(/Copy it again/);
  });

  it('refuses a paste from an AI run, and a copy of a revision the editor no longer shows', async () => {
    const { s } = await make();
    const home = s.state.site.homePageId;
    const stale = await s.copy(home, grid(s).id, s.revision - 1);
    expect(stale).toMatchObject({ ok: false, message: expect.stringMatching(/changed while copying/) });
    const missing = await s.copy(home, 'n_missing', s.revision);
    expect(missing.ok).toBe(false);
    const c = await s.copy(home, grid(s).id, s.revision);
    const r = await s.apply({ operations: [{ type: 'node.paste', clipboardId: c.clipboardId!, toOwner: { kind: 'page', id: contact(s).id } }] }, { label: 'Paste', source: 'ai' });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/only for the editor/);
  });
});

describe('placement role (#661)', () => {
  it('is set in one step Undo takes back, and only from the editor', async () => {
    const { s } = await make();
    const home = s.state.pages[s.state.site.homePageId];
    const themed = home.rootIds.map((id) => home.nodes[id] as InstanceNode).find((n) => s.state.components[n.definitionId]?.componentId === 'features.grid')!;
    const fork = await s.apply({ operations: [{ type: 'component.fork', definitionId: themed.definitionId }] }, { label: 'Make a project copy', source: 'user' });
    const definitionId = fork.results![0].definitionId as string;
    const entries = s.historyInfo().entries.length;
    const revision = s.revision;
    const refused = await s.apply({ operations: [{ type: 'component.setInsertAs', definitionId, insertAs: 'element' }] }, { label: 'Set role', source: 'ai' });
    expect(refused.ok).toBe(false);
    expect(refused.error?.message).toMatch(/only for the editor/);
    expect(s.state.components[definitionId].insertAs).toBeUndefined();
    expect([s.revision, s.historyInfo().entries.length]).toEqual([revision, entries]);
    const r = await s.apply({ operations: [{ type: 'component.setInsertAs', definitionId, insertAs: 'element' }] }, { label: 'Insert as a subcomponent', source: 'user' });
    expect(r.ok).toBe(true);
    expect(s.state.components[definitionId].insertAs).toBe('element');
    expect(s.historyInfo().entries.length).toBe(entries + 1);
    expect((await s.undo()).ok).toBe(true);
    expect(s.state.components[definitionId].insertAs).toBeUndefined();
  });
});

describe('section links', () => {
  it('saves a section pick as one step, and lets a linked section be deleted and reported', async () => {
    // The linked section is one built in the editor, after the Contact page's introduction.
    const { s } = await make(startWithCards(1, (st) => Object.values(st.pages).find((p) => p.route === '/contact/')!.id).start);
    const contact = s.state.site.pageOrder.map((id) => s.state.pages[id]).find((p) => p.route === '/contact/')!;
    const details = contact.rootIds[1];
    expect(s.state.components[(contact.nodes[details] as InstanceNode).definitionId].owner).toBe('project');
    const header = s.state.site.shell.header.rootIds[0];
    const page = { kind: 'page' as const, id: contact.id };
    const pick = await s.apply(
      {
        expectedRevision: s.revision,
        operations: [
          { type: 'node.setContent', owner: page, nodeId: details, field: 'anchor', value: 'get-in-touch' },
          { type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: header, prop: 'ctaLink', value: { type: 'page', target: contact.id, anchor: 'get-in-touch' } }
        ]
      },
      { label: 'Edit Action link' }
    );
    expect(pick.ok).toBe(true);
    const missing = () => s.diagnostics().filter((d) => d.code === 'LINK_SECTION_MISSING');
    expect(missing()).toEqual([]);
    const cta = () => (s.state.site.shell.header.nodes[header] as { props: Record<string, unknown> }).props.ctaLink;
    await s.undo();
    expect(s.state.pages[contact.id].nodes[details].anchor).toBeUndefined();
    expect(cta()).toEqual({ type: 'page', target: contact.id });
    await s.redo();
    expect(s.state.pages[contact.id].nodes[details].anchor).toBe('get-in-touch');
    expect((cta() as { anchor?: string }).anchor).toBe('get-in-touch');

    // Deleting the section is allowed; Project health then names the link that lost its destination.
    const removed = await s.apply({ operations: [{ type: 'node.remove', owner: page, nodeId: details }] }, { label: 'Delete section' });
    expect(removed.ok).toBe(true);
    expect(missing()).toHaveLength(1);
    expect(missing()[0].message).toContain('Book a call');
    await s.undo();
    expect(missing()).toEqual([]);
  });

  it('refuses a section pick planned against an older revision', async () => {
    const { s } = await make();
    const contact = s.state.site.pageOrder.map((id) => s.state.pages[id]).find((p) => p.route === '/contact/')!;
    const planned = s.revision;
    await s.apply({ operations: [{ type: 'site.update', name: 'Moved on' }] }, { label: 'Rename site' });
    const header = s.state.site.shell.header.rootIds[0];
    const r = await s.apply(
      {
        expectedRevision: planned,
        operations: [
          { type: 'node.setContent', owner: { kind: 'page', id: contact.id }, nodeId: contact.rootIds[1], field: 'anchor', value: 'get-in-touch' },
          { type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: header, prop: 'ctaLink', value: { type: 'page', target: contact.id, anchor: 'get-in-touch' } }
        ]
      },
      { label: 'Pick' }
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('STALE_REVISION');
    expect(s.state.pages[contact.id].nodes[contact.rootIds[1]].anchor).toBeUndefined();
  });
});

describe('undoing one history entry', () => {
  const homeOwner = (s: ProjectSession) => ({ kind: 'page' as const, id: s.state.site.homePageId });
  const home = (s: ProjectSession) => s.state.pages[s.state.site.homePageId];
  const logos = (s: ProjectSession) => home(s).rootIds.map((id) => home(s).nodes[id] as InstanceNode).find((n) => s.state.components[n.definitionId]?.componentId === 'logos.strip')!;
  const setTitle = (s: ProjectSession, seoTitle: string) => s.apply({ operations: [{ type: 'page.update', pageId: home(s).id, seoTitle }] }, { label: 'Edit browser title' });
  const unchanged = (s: ProjectSession) => ({ revision: s.revision, history: s.historyInfo(), state: structuredClone(s.state) });

  it('reports the history entry each change was recorded in', async () => {
    const { s } = await make();
    const r = await s.apply({ operations: [{ type: 'site.update', name: 'One' }] }, { label: 'Rename site', coalesceKey: 'site-name' });
    expect(r.entryId).toBe(s.historyInfo().entries.at(-1)!.id);
    // A change folded into the previous entry belongs to that entry.
    const folded = await s.apply({ operations: [{ type: 'site.update', name: 'Two' }] }, { label: 'Rename site', coalesceKey: 'site-name' });
    expect(folded.entryId).toBe(r.entryId);
    const same = await s.apply({ operations: [{ type: 'site.update', name: 'Two' }] }, { label: 'Rename site' });
    expect(same.ok).toBe(true);
    expect(same.entryId).toBeUndefined();
  });

  it('undoes the newest entry like Undo, keeping Redo', async () => {
    const { s } = await make();
    const id = logos(s).id;
    const r = await s.apply({ operations: [{ type: 'node.remove', owner: homeOwner(s), nodeId: id }] }, { label: 'Delete Logo strip' });
    expect((await s.undoEntry(r.entryId!)).ok).toBe(true);
    expect(home(s).nodes[id]).toBeDefined();
    expect(s.historyInfo()).toMatchObject({ canRedo: true, redoLabel: 'Delete Logo strip' });
    expect(await s.undoEntry(r.entryId!)).toMatchObject({ ok: false, error: { code: 'CONFLICT', message: '“Delete Logo strip” was already undone.' } });
    expect(await s.undoEntry('h_missing')).toMatchObject({ ok: false, error: { code: 'CONFLICT', message: 'That change is no longer in History.' } });
  });

  it('puts an older section removal back on its own as a new change that survives reopening', async () => {
    const { dir, s } = await make();
    const id = logos(s).id;
    const order = [...home(s).rootIds];
    const r = await s.apply({ operations: [{ type: 'node.remove', owner: homeOwner(s), nodeId: id }] }, { label: 'Delete Logo strip' });
    await setTitle(s, 'November client proof');
    const u = await s.undoEntry(r.entryId!);
    expect(u.ok).toBe(true);
    expect(u.entryId).toBe(s.historyInfo().entries.at(-1)!.id);
    expect(home(s).rootIds).toEqual(order);
    expect(home(s).seo.title).toBe('November client proof');
    expect(s.historyInfo().entries.map((e) => e.label).slice(-3)).toEqual(['Delete Logo strip', 'Edit browser title', 'Restore Logo strip']);
    await s.close();
    const again = await ProjectSession.open(dir, 'test');
    expect(again.state.pages[again.state.site.homePageId].rootIds).toEqual(order);
    await again.undo();
    expect(again.state.pages[again.state.site.homePageId].nodes[id]).toBeUndefined();
    expect(again.state.pages[again.state.site.homePageId].seo.title).toBe('November client proof');
    await again.close();
  });

  it('refuses an older change it cannot undo on its own, changing nothing', async () => {
    const { s } = await make();
    const site = await s.apply({ operations: [{ type: 'site.update', name: 'Renamed' }] }, { label: 'Rename site' });
    await setTitle(s, 'Later');
    const before = unchanged(s);
    expect(await s.undoEntry(site.entryId!)).toMatchObject({ ok: false, error: { code: 'CONFLICT', message: 'Other changes came after “Rename site”. Open History to undo it.' } });
    expect(unchanged(s)).toEqual(before);
  });

  it('refuses to bring back a section whose component has been removed since', async () => {
    const { s } = await make();
    const node = logos(s);
    const r = await s.apply({ operations: [{ type: 'node.remove', owner: homeOwner(s), nodeId: node.id }] }, { label: 'Delete Logo strip' });
    const removed = await s.apply({ operations: [{ type: 'component.remove', definitionId: node.definitionId }] }, { label: 'Remove component' });
    expect(removed.error?.message).toBeUndefined();
    const before = unchanged(s);
    const u = await s.undoEntry(r.entryId!);
    expect(u).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(u.error!.message).toMatch(/^Other changes came after “Delete Logo strip”, so it can’t be undone on its own\. .+ Open History to undo it\.$/);
    expect(unchanged(s)).toEqual(before);
  });

  it('refuses a deletion made in one step with another change to the page', async () => {
    const { s } = await make();
    const r = await s.apply({ operations: [{ type: 'node.remove', owner: homeOwner(s), nodeId: logos(s).id }, { type: 'page.update', pageId: home(s).id, seoTitle: 'Together' }] }, { label: 'Delete Logo strip' });
    await s.apply({ operations: [{ type: 'site.update', name: 'Later' }] }, { label: 'Rename site' });
    const before = unchanged(s);
    expect(await s.undoEntry(r.entryId!)).toMatchObject({ ok: false, error: { message: 'Other changes came after “Delete Logo strip”. Open History to undo it.' } });
    expect(unchanged(s)).toEqual(before);
  });

  it('undoes a whole entry that later edits were folded into, as Undo would', async () => {
    const { s } = await make();
    const r = await s.apply({ operations: [{ type: 'site.update', name: 'One' }] }, { label: 'Rename site', coalesceKey: 'site-name' });
    await s.apply({ operations: [{ type: 'site.update', name: 'Two' }] }, { label: 'Rename site', coalesceKey: 'site-name' });
    expect((await s.undoEntry(r.entryId!)).ok).toBe(true);
    expect(s.state.site.name).toBe('Persist');
    await s.redo();
    expect(s.state.site.name).toBe('Two');
  });

  it('refuses to bring back an anchor something else on the page has taken since', async () => {
    // Two sections built in the editor, which take anchors: the second stands where the logo strip was.
    const { start } = startWithCards(0);
    const second = makeInstance(start.components['foundation.test.cards']);
    const page = start.pages[start.site.homePageId];
    page.nodes[second.id] = second;
    page.rootIds.splice(2, 0, second.id);
    const { s } = await make(start);
    const node = home(s).nodes[second.id] as InstanceNode;
    expect((await s.apply({ operations: [{ type: 'node.setContent', owner: homeOwner(s), nodeId: node.id, field: 'anchor', value: 'offer' }] }, { label: 'Anchor' })).ok).toBe(true);
    const r = await s.apply({ operations: [{ type: 'node.remove', owner: homeOwner(s), nodeId: node.id }] }, { label: 'Delete Logo strip' });
    const other = home(s).rootIds[0];
    expect((await s.apply({ operations: [{ type: 'node.setContent', owner: homeOwner(s), nodeId: other, field: 'anchor', value: 'offer' }] }, { label: 'Anchor' })).ok).toBe(true);
    const before = unchanged(s);
    expect((await s.undoEntry(r.entryId!)).error?.message).toBe('Other changes came after “Delete Logo strip”, so it can’t be undone on its own. Something else on the page now uses its anchor “#offer”. Open History to undo it.');
    expect(unchanged(s)).toEqual(before);
  });

  it('refuses, changing nothing, when history no longer holds the page it needs', async () => {
    const { dir, s } = await make();
    const r = await s.apply({ operations: [{ type: 'node.remove', owner: homeOwner(s), nodeId: logos(s).id }] }, { label: 'Delete Logo strip' });
    await setTitle(s, 'Later');
    const entry = JSON.parse(readFileSync(join(dir, '.siteorigin/history/history.json'), 'utf8')).entries.find((e: { id: string }) => e.id === r.entryId);
    const [doc] = Object.values(entry.docs) as Array<{ before: string }>;
    rmSync(join(dir, '.siteorigin/history/blobs', `${doc.before}.json`));
    const before = unchanged(s);
    expect((await s.undoEntry(r.entryId!)).error?.message).toBe('Other changes came after “Delete Logo strip”, so it can’t be undone on its own. History no longer holds the page as it was. Open History to undo it.');
    expect(unchanged(s)).toEqual(before);
  });

  it('never puts a section into a page made again with the same ID', async () => {
    const { s } = await make();
    const pageId = 'pg_demo1';
    await s.apply({ operations: [{ type: 'page.create', pageId, title: 'Demo', starter: 'intro' }] }, { label: 'Add page' });
    const owner = { kind: 'page' as const, id: pageId };
    const r = await s.apply({ operations: [{ type: 'node.remove', owner, nodeId: s.state.pages[pageId].rootIds[0] }] }, { label: 'Delete Intro' });
    await s.apply({ operations: [{ type: 'page.remove', pageId }] }, { label: 'Delete page' });
    await s.apply({ operations: [{ type: 'page.create', pageId, title: 'Demo', starter: 'empty' }] }, { label: 'Add page' });
    const before = unchanged(s);
    expect((await s.undoEntry(r.entryId!)).error?.message).toBe('Other changes came after “Delete Intro”, so it can’t be undone on its own. Its page has been deleted and made again since. Open History to undo it.');
    expect(unchanged(s)).toEqual(before);
  });

  it('orders neighbours put back by their Undo from what the page went through, never from a change undone since', async () => {
    const { s } = await make();
    const order = [...home(s).rootIds];
    const [a, b] = order.slice(1, 3);
    const del = async (id: string) => (await s.apply({ operations: [{ type: 'node.remove', owner: homeOwner(s), nodeId: id }] }, { label: 'Delete' })).entryId!;
    const x = await del(a);
    const y = await del(b);
    expect((await s.undoEntry(x)).ok).toBe(true);
    expect((await s.undoEntry(y)).ok).toBe(true);
    expect(home(s).rootIds).toEqual(order);
    // Move B in front of A, then take back the move and B's restore with Undo: the page shows A alone again.
    await s.apply({ operations: [{ type: 'node.move', owner: homeOwner(s), nodeId: b, parentId: null, index: 1 }] }, { label: 'Move up' });
    expect(home(s).rootIds.slice(1, 3)).toEqual([b, a]);
    await s.undo();
    await s.undo();
    expect(home(s).rootIds).toEqual(order.filter((id) => id !== b));
    expect((await s.undoEntry(y)).ok).toBe(true);
    expect(home(s).rootIds).toEqual(order);
  });

  it('refuses to order a section by guesswork when history has lost the version that showed it', async () => {
    const { dir, s } = await make();
    const order = [...home(s).rootIds];
    const [a, b] = order.slice(1, 3);
    const x = await s.apply({ operations: [{ type: 'node.remove', owner: homeOwner(s), nodeId: a }] }, { label: 'Delete A' });
    const y = await s.apply({ operations: [{ type: 'node.remove', owner: homeOwner(s), nodeId: b }] }, { label: 'Delete B' });
    expect((await s.undoEntry(x.entryId!)).ok).toBe(true);
    // The page before A was deleted is the only version holding both A and B.
    const entry = JSON.parse(readFileSync(join(dir, '.siteorigin/history/history.json'), 'utf8')).entries.find((e: { id: string }) => e.id === x.entryId);
    const [doc] = Object.values(entry.docs) as Array<{ before: string }>;
    rmSync(join(dir, '.siteorigin/history/blobs', `${doc.before}.json`));
    const before = unchanged(s);
    expect((await s.undoEntry(y.entryId!)).error?.message).toBe('Other changes came after “Delete B”, so it can’t be undone on its own. History no longer holds the page as it was. Open History to undo it.');
    expect(unchanged(s)).toEqual(before);
  });

  it('waits for the AI like Undo', async () => {
    const { s } = await make();
    const r = await s.apply({ operations: [{ type: 'site.update', name: 'Renamed' }] }, { label: 'Rename site' });
    await s.beginRun('run_entry');
    expect(await s.undoEntry(r.entryId!)).toMatchObject({ ok: false, error: { code: 'BUSY' } });
  });

  it('turns a guarded change away whole as its journal is about to take its place, with no failed save (#765)', async () => {
    const { dir, s } = await make();
    const home = s.state.site.homePageId;
    const page = join(dir, `siteorigin/pages/${home}.json`);
    const before = { text: readFileSync(page, 'utf8'), revision: s.revision, history: JSON.stringify(s.historyInfo()) };
    const failed: number[] = [];
    s.on('save-failed', () => failed.push(s.revision));
    // Allowed as the change's turn comes and as it is checked; withdrawn only at the journal, after its blobs are written.
    const asked: Array<'turn' | 'state'> = [];
    const guard = (next: unknown) => {
      asked.push(next ? 'state' : 'turn');
      // The second look at the project as the change leaves it is the one as its journal is about to take its place.
      return asked.filter((a) => a === 'state').length >= 2 ? { code: 'CANCELLED' as const, message: 'Access changed.', recoverable: false } : null;
    };
    const r = await s.apply({ operations: [{ type: 'page.update', pageId: home, title: 'Guarded' }] }, { label: 'Rename (Ann)', guestName: 'Ann', guard });
    expect(asked).toEqual(['turn', 'state', 'state']);
    expect(r).toMatchObject({ ok: false, revision: before.revision, error: { code: 'CANCELLED', message: 'Access changed.' } });
    expect(s.state.pages[home].title).not.toBe('Guarded');
    expect(readFileSync(page, 'utf8')).toBe(before.text);
    expect(s.revision).toBe(before.revision);
    expect(JSON.stringify(s.historyInfo())).toBe(before.history);
    expect(existsSync(join(dir, '.siteorigin', 'journal.json'))).toBe(false);
    expect(readdirSync(join(dir, '.siteorigin')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(s.saveFailure).toBeNull();
    expect(failed).toEqual([]);
    // The session carries on: the next change saves, as a step that names its guest.
    const ok = await s.apply({ operations: [{ type: 'page.update', pageId: home, title: 'Allowed' }] }, { label: 'Rename (Ann)', guestName: 'Ann', guard: () => null });
    expect(ok.ok).toBe(true);
    expect(s.historyInfo().entries.at(-1)).toMatchObject({ label: 'Rename (Ann)', guestName: 'Ann', source: 'user' });
    await s.close();
  });
});
