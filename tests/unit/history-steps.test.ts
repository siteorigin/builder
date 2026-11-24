/**
 * Stepping History to an entry chosen in it (#199): several entries back or ahead in one change, which survives
 * reopening, keeps what was undone redoable until a new change is made, and is refused whole, changing nothing, when
 * any entry on the way no longer matches the project or History has moved since the entry was shown.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarterState } from '@catalogue/starters';
import { ProjectSession } from '../../src/main/project/session';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A project with four changes, oldest first: the site renamed, then the browser titles of Home, About and Contact. */
async function fourChanges() {
  const dir = mkdtempSync(join(tmpdir(), 'so-steps-'));
  dirs.push(dir);
  const s = await ProjectSession.create(dir, createStarterState('business', 'Steps', false));
  const [home, about, contact] = s.state.site.pageOrder;
  const start = shown(s, [home, about, contact]);
  const ok = async (p: ReturnType<ProjectSession['apply']>) => expect((await p).ok).toBe(true);
  await ok(s.apply({ operations: [{ type: 'site.update', name: 'Renamed' }] }, { label: 'Rename site' }));
  await ok(s.apply({ operations: [{ type: 'page.update', pageId: home, seoTitle: 'Home title' }] }, { label: 'Title Home' }));
  await ok(s.apply({ operations: [{ type: 'page.update', pageId: about, seoTitle: 'About title' }] }, { label: 'Title About' }));
  await ok(s.apply({ operations: [{ type: 'page.update', pageId: contact, seoTitle: 'Contact title' }] }, { label: 'Title Contact' }));
  const ids = s.historyInfo().entries.map((e) => e.id);
  return { dir, s, home, about, contact, ids, start };
}

/** What each change set, read from the project: the site name and the three titles. */
const shown = (s: ProjectSession, pages: string[]) => [s.state.site.name, ...pages.map((id) => s.state.pages[id].seo.title ?? null)];
const applied = (s: ProjectSession) => s.historyInfo().entries.map((e) => e.applied);
const unchanged = (s: ProjectSession) => ({ revision: s.revision, history: s.historyInfo(), state: structuredClone(s.state) });

describe('stepping History to a chosen entry', () => {
  it('undoes several entries back in one change, and redoes them again in one', async () => {
    const { s, home, about, contact, ids, start } = await fourChanges();
    const pages = [home, about, contact];
    const titles = shown(s, pages);
    const rev = s.revision;
    // Undo back through "Title Home": it and the two after it go, the rename stays.
    const r = await s.stepTo(ids[1], 'undo');
    expect(r.ok).toBe(true);
    expect(s.revision).toBe(rev + 1);
    expect(shown(s, pages)).toEqual(['Renamed', ...start.slice(1)]);
    expect(applied(s)).toEqual([true, false, false, false]);
    expect(s.historyInfo()).toMatchObject({ canUndo: true, canRedo: true, undoLabel: 'Rename site', redoLabel: 'Title Home' });
    // Redo forward up to "Title About": two entries come back, "Title Contact" stays undone.
    expect((await s.stepTo(ids[2], 'redo')).ok).toBe(true);
    expect(s.revision).toBe(rev + 2);
    expect(shown(s, pages)).toEqual(['Renamed', 'Home title', 'About title', start[3]]);
    expect(applied(s)).toEqual([true, true, true, false]);
    // And the rest of the way, back where it started.
    expect((await s.stepTo(ids[3], 'redo')).ok).toBe(true);
    expect(shown(s, pages)).toEqual(titles);
    expect(applied(s)).toEqual([true, true, true, true]);
    await s.close();
  });

  it('undoes everything from the oldest entry, and the jump survives reopening', async () => {
    const { dir, s, home, about, contact, ids, start } = await fourChanges();
    expect((await s.stepTo(ids[0], 'undo')).ok).toBe(true);
    expect(shown(s, [home, about, contact])).toEqual(start);
    expect(s.historyInfo()).toMatchObject({ canUndo: false, canRedo: true, redoLabel: 'Rename site' });
    await s.close();
    const again = await ProjectSession.open(dir, 'test');
    expect(shown(again, [home, about, contact])).toEqual(start);
    expect(applied(again)).toEqual([false, false, false, false]);
    expect((await again.stepTo(ids[3], 'redo')).ok).toBe(true);
    expect(shown(again, [home, about, contact])).toEqual(['Renamed', 'Home title', 'About title', 'Contact title']);
    await again.close();
  });

  it('keeps what was undone redoable, step by step too, until a new change is made', async () => {
    const { s, about, ids } = await fourChanges();
    await s.stepTo(ids[1], 'undo');
    // Single steps carry on from where the jump left History.
    expect((await s.redo()).ok).toBe(true);
    expect(s.historyInfo()).toMatchObject({ undoLabel: 'Title Home', redoLabel: 'Title About' });
    expect((await s.undo()).ok).toBe(true);
    expect(s.historyInfo().redoLabel).toBe('Title Home');
    // A new change drops the undone entries, as it does after a single Undo.
    await s.apply({ operations: [{ type: 'page.update', pageId: about, seoTitle: 'Fresh' }] }, { label: 'Title About again' });
    expect(s.historyInfo().entries.map((e) => e.label)).toEqual(['Rename site', 'Title About again']);
    expect(s.historyInfo().canRedo).toBe(false);
    expect(await s.stepTo(ids[3], 'redo')).toMatchObject({ ok: false, error: { code: 'CONFLICT', message: 'That change is no longer in History.' } });
    await s.close();
  });

  it('names one entry like Undo and Redo, and several by how many', async () => {
    const { s, ids } = await fourChanges();
    const labels: string[] = [];
    s.on('changed', (e: { label: string }) => labels.push(e.label));
    await s.stepTo(ids[3], 'undo');
    await s.stepTo(ids[0], 'undo');
    await s.stepTo(ids[3], 'redo');
    expect(labels).toEqual(['Undo Title Contact', 'Undo 3 changes', 'Redo 4 changes']);
    await s.close();
  });

  it('refuses an entry that History has already moved past, changing nothing', async () => {
    const { s, ids } = await fourChanges();
    await s.stepTo(ids[2], 'undo');
    const before = unchanged(s);
    // Shown as applied, then undone (by Cmd+Z, say) before the click arrived.
    expect(await s.stepTo(ids[3], 'undo')).toMatchObject({ ok: false, error: { code: 'CONFLICT', message: '“Title Contact” was already undone.' } });
    // Shown as undone, then redone.
    expect(await s.stepTo(ids[1], 'redo')).toMatchObject({ ok: false, error: { code: 'CONFLICT', message: '“Title Home” was already redone.' } });
    expect(await s.stepTo('h_missing', 'undo')).toMatchObject({ ok: false, error: { code: 'CONFLICT', message: 'That change is no longer in History.' } });
    expect(unchanged(s)).toEqual(before);
    await s.close();
  });

  it('refuses a step chosen before the project moved on, even one folded into the same entry', async () => {
    const { s, about, ids } = await fourChanges();
    const shownAt = s.revision;
    // Typed into the same field again: the change joins "Title Contact", so the row's count would still read the same.
    const [, , contact] = s.state.site.pageOrder;
    const folded = await s.apply({ operations: [{ type: 'page.update', pageId: contact, seoTitle: 'Contact title, longer' }] }, { label: 'Title Contact', coalesceKey: 'contact-title' });
    expect(folded.ok).toBe(true);
    const before = unchanged(s);
    expect(await s.stepTo(ids[2], 'undo', shownAt)).toMatchObject({ ok: false, error: { code: 'STALE_REVISION', message: 'History changed. Choose the change again.' } });
    expect(unchanged(s)).toEqual(before);
    expect((await s.stepTo(ids[2], 'undo', s.revision)).ok).toBe(true);
    expect(s.state.pages[about].seo.title).not.toBe('About title');
    await s.close();
  });

  it('waits for an outside edit to a page the jump changes and changes back', async () => {
    const { dir, s, home, about } = await fourChanges();
    await s.apply({ operations: [{ type: 'page.update', pageId: about, seoTitle: 'Second' }] }, { label: 'Title About again' });
    await s.apply({ operations: [{ type: 'page.update', pageId: about, seoTitle: 'About title' }] }, { label: 'Title About back' });
    await s.apply({ operations: [{ type: 'page.update', pageId: home, seoTitle: 'Home again' }] }, { label: 'Title Home again' });
    const second = s.historyInfo().entries.find((e) => e.label === 'Title About again')!.id;
    // About's file edited outside the app, not loaded yet. Undoing back through "Title About again" leaves About's
    // page as it is in the app, so the save would not look at it.
    const aboutPath = join(dir, `siteorigin/pages/${about}.json`);
    writeFileSync(aboutPath, JSON.stringify({ ...JSON.parse(readFileSync(aboutPath, 'utf8')), seo: { title: 'By hand' } }, null, 2) + '\n');
    const before = unchanged(s);
    const r = await s.stepTo(second, 'undo', s.revision);
    expect(r).toMatchObject({ ok: false, error: { code: 'CONFLICT', recoverable: true } });
    expect(r.error?.message).toBe(`Cannot undo 3 changes yet: siteorigin/pages/${about}.json changed outside the app. Try again in a moment.`);
    expect(unchanged(s)).toEqual(before);
    expect(JSON.parse(readFileSync(aboutPath, 'utf8')).seo.title).toBe('By hand');
    await s.close();
  });

  it('steps across a page made and removed, both ways', async () => {
    const { s, ids } = await fourChanges();
    const made = await s.apply({ operations: [{ type: 'page.create', title: 'Experiments' }] }, { label: 'Add page Experiments' });
    const page = Object.values(s.state.pages).find((p) => p.title === 'Experiments')!.id;
    await s.apply({ operations: [{ type: 'page.update', pageId: page, seoTitle: 'Trying things' }] }, { label: 'Title Experiments' });
    await s.apply({ operations: [{ type: 'page.remove', pageId: page }] }, { label: 'Delete page Experiments' });
    expect(Object.hasOwn(s.state.pages, page)).toBe(false);
    // Back to before the page was made: it is not brought back on the way through.
    expect((await s.stepTo(made.entryId!, 'undo', s.revision)).ok).toBe(true);
    expect(Object.hasOwn(s.state.pages, page)).toBe(false);
    expect(s.state.site.pageOrder).not.toContain(page);
    // Forward to just before it was removed: the page is back, with its title.
    const titled = s.historyInfo().entries.find((e) => e.label === 'Title Experiments')!.id;
    expect((await s.stepTo(titled, 'redo', s.revision)).ok).toBe(true);
    expect(s.state.pages[page].seo.title).toBe('Trying things');
    expect(s.state.site.pageOrder).toContain(page);
    // And all the way back to the start, then forward through all of it.
    expect((await s.stepTo(ids[0], 'undo', s.revision)).ok).toBe(true);
    expect(s.state.site.name).toBe('Steps');
    const last = s.historyInfo().entries.at(-1)!.id;
    expect((await s.stepTo(last, 'redo', s.revision)).ok).toBe(true);
    expect(Object.hasOwn(s.state.pages, page)).toBe(false);
    expect(s.state.site.name).toBe('Renamed');
    await s.close();
  });

  it('refuses the whole jump when an entry on the way no longer matches the project, undoing none of it', async () => {
    const { dir, s, about, ids } = await fourChanges();
    await s.close();
    // About's page edited by hand: "Title About" can no longer be taken back, nor anything before it.
    const aboutPath = join(dir, `siteorigin/pages/${about}.json`);
    writeFileSync(aboutPath, JSON.stringify({ ...JSON.parse(readFileSync(aboutPath, 'utf8')), seo: { title: 'By hand' } }, null, 2) + '\n');
    const again = await ProjectSession.open(dir, 'test');
    const before = unchanged(again);
    const r = await again.stepTo(ids[0], 'undo');
    expect(r).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    expect(r.error?.message).toBe(`Cannot undo "Title About" because siteorigin/pages/${about}.json has changed since.`);
    // "Title Contact", nearer the present, was not undone on its own either.
    expect(unchanged(again)).toEqual(before);
    // Back to just after it still works.
    expect((await again.stepTo(ids[3], 'undo')).ok).toBe(true);
    expect(again.state.pages[about].seo.title).toBe('By hand');
    await again.close();
  });
});
