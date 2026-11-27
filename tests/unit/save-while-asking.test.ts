import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarterState } from '@catalogue/starters';
import type { EditOperation } from '@shared/ops';
import type { ProjectState } from '@shared/types';
import { ProjectSession } from '../../src/main/project/session';
import { readFields } from '../../src/renderer/src/lib/held';
import { applyOperations } from '@engine/apply';
import { brandPlacements } from '@shared/site-name';
import { stateToDocs } from '../../src/main/project/documents';

/**
 * An author's held edit saved while an AI request waits for their answer (#1281): it lands in the project and in the
 * run's checkpoint together, so stopping the request, or a crash, keeps it, and the run's own step never holds it.
 */
const dirs: string[] = [];
const open: ProjectSession[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
async function make() {
  const dir = mkdtempSync(join(tmpdir(), 'so-asking-'));
  dirs.push(dir);
  const s = await ProjectSession.create(dir, createStarterState('business', 'Persist', false));
  open.push(s);
  return { dir, s };
}
async function reopen(dir: string) {
  const s = await ProjectSession.open(dir, 'again', { force: true });
  open.push(s);
  return s;
}
const SITE = 'siteorigin/site.json';
const read = (dir: string, rel: string) => JSON.parse(readFileSync(join(dir, rel), 'utf8'));
const URL = 'https://example.com/builder';

/** What each field `ops` writes holds in `state`: what the author saw when they made the edit, as the editor reads it. */
const seen = (state: ProjectState, ops: EditOperation[]) => readFields(state, ops)!.map((r) => (r.found ? r.value : undefined));
const urlEdit = (url = URL): EditOperation[] => [{ type: 'site.update', baseUrl: url }];

/** A run that renamed the site (in site.json, where the Public URL is too) and is now waiting for an answer. */
async function waitingRun() {
  const { dir, s } = await make();
  const baseUrl = s.state.site.baseUrl;
  // The author began typing before the run started.
  const typed = seen(s.state, urlEdit());
  expect(await s.beginRun('run_q')).toBeNull();
  expect((await s.apply({ operations: [{ type: 'site.update', name: 'AI name' }] }, { label: 'AI', source: 'ai', runId: 'run_q', history: false })).ok).toBe(true);
  return { dir, s, baseUrl, typed };
}
/** The author's Public URL edit, made where the fields held `base`. */
const saveUrl = (s: ProjectSession, base: unknown[], url = URL) => s.apply({ operations: urlEdit(url) }, { label: 'Update site settings', source: 'user', asking: { runId: 'run_q', base } });

describe('an edit saved while the AI waits for an answer (#1281)', () => {
  it('lands at once beside the run’s change, and stopping the request undoes only the AI’s', async () => {
    const { dir, s, baseUrl, typed } = await waitingRun();
    const revision = s.revision;
    const r = await saveUrl(s, typed);
    expect(r.ok).toBe(true);
    expect(r.revision).toBe(revision + 1);
    expect(s.state.site).toMatchObject({ name: 'AI name', baseUrl: URL });
    expect(read(dir, SITE)).toMatchObject({ name: 'AI name', baseUrl: URL });
    // The run still holds the project: the author's step is in History, and it cannot be undone until the run ends.
    expect(s.runChanged()).toBe(true);
    expect(s.historyInfo().canUndo).toBe(false);
    expect(await s.abortRun()).toEqual({ restored: true });
    expect(s.state.site).toMatchObject({ name: 'Persist', baseUrl: URL });
    expect(read(dir, SITE)).toMatchObject({ name: 'Persist', baseUrl: URL });
    expect(existsSync(join(dir, '.siteorigin/sessions/active-run.json'))).toBe(false);
    // Undo takes back the author's own step, the only one.
    const steps = s.historyInfo().entries;
    expect(steps.map((e) => [e.label, e.source])).toEqual([['Update site settings', 'user']]);
    expect((await s.undo()).ok).toBe(true);
    expect(s.state.site.name).toBe('Persist');
    expect(s.state.site.baseUrl).toBe(baseUrl);
  });

  it('keeps the author’s step apart from the AI’s when the request finishes', async () => {
    const { s, baseUrl, typed } = await waitingRun();
    expect((await saveUrl(s, typed)).ok).toBe(true);
    // The AI goes on once answered, from the project as it is now.
    expect((await s.apply({ operations: [{ type: 'site.update', description: 'AI words' }] }, { label: 'AI', source: 'ai', runId: 'run_q', history: false })).ok).toBe(true);
    expect(await s.completeRun('AI: rename')).toBe(true);
    expect(s.historyInfo().entries.map((e) => [e.label, e.source])).toEqual([
      ['Update site settings', 'user'],
      ['AI: rename', 'ai']
    ]);
    // Undoing the AI's step (as its card's Undo does) keeps the author's edit; undoing the author's then takes the URL back.
    expect((await s.undoGroup('run_q')).ok).toBe(true);
    expect(s.state.site).toMatchObject({ name: 'Persist', baseUrl: URL });
    expect(s.state.site.description).not.toBe('AI words');
    expect((await s.undo()).ok).toBe(true);
    expect(s.state.site.name).toBe('Persist');
    expect(s.state.site.baseUrl).toBe(baseUrl);
    expect((await s.redo()).ok).toBe(true);
    expect((await s.redo()).ok).toBe(true);
    expect(s.state.site).toMatchObject({ name: 'AI name', baseUrl: URL, description: 'AI words' });
  });

  it('survives a crash while the AI still waits: reopening restores the checkpoint with the edit in it', async () => {
    const { dir, s, baseUrl, typed } = await waitingRun();
    expect(baseUrl).not.toBe(URL);
    expect((await saveUrl(s, typed)).ok).toBe(true);
    // The app goes down with the run still open: its marker is on disk.
    expect(existsSync(join(dir, '.siteorigin/sessions/active-run.json'))).toBe(true);
    const saved = s.revision;
    await s.releaseLock();
    const again = await reopen(dir);
    expect(again.conflicts).toEqual([]);
    expect(again.revision).toBe(saved);
    expect(again.state.site).toMatchObject({ name: 'Persist', baseUrl: URL });
    expect(again.historyInfo().entries.map((e) => e.label)).toEqual(['Update site settings']);
    expect((await again.undo()).ok).toBe(true);
    expect(again.state.site.baseUrl).toBe(baseUrl);
  });

  it('waits for the request to end when the run changed the field, even if the author saw the AI’s value', async () => {
    const { s, typed } = await waitingRun();
    expect((await s.apply({ operations: [{ type: 'site.update', baseUrl: 'https://ai.example' }] }, { label: 'AI', source: 'ai', runId: 'run_q', history: false })).ok).toBe(true);
    const revision = s.revision;
    // Typed over the value from before the run: it changed under the author.
    const stale = await saveUrl(s, typed);
    expect(stale).toMatchObject({ ok: false, error: { code: 'CONFLICT', details: { held: 'changed' } } });
    // Typed over the AI's own value: stopping the request would take that back, so it waits too.
    const early = await saveUrl(s, seen(s.state, urlEdit()));
    expect(early).toMatchObject({ ok: false, error: { code: 'CONFLICT', details: { held: 'differs' } } });
    expect(early.error!.message).toMatch(/once the AI request ends/);
    expect(s.revision).toBe(revision);
    expect(s.state.site.baseUrl).toBe('https://ai.example');
  });

  it('waits for the request to end when one field of several is one the run changed, saving none of them', async () => {
    const { s } = await waitingRun();
    expect((await s.apply({ operations: [{ type: 'site.update', baseUrl: 'https://ai.example' }] }, { label: 'AI', source: 'ai', runId: 'run_q', history: false })).ok).toBe(true);
    const ops: EditOperation[] = [{ type: 'site.update', description: 'Mine' }, ...urlEdit()];
    // The author saw the URL as it was before the run.
    const base = [seen(s.state, ops)[0], { baseUrl: undefined }];
    const revision = s.revision;
    expect(await s.apply({ operations: ops }, { label: 'x', source: 'user', asking: { runId: 'run_q', base } })).toMatchObject({ ok: false, error: { code: 'CONFLICT', details: { held: 'changed' } } });
    expect(s.revision).toBe(revision);
    expect(s.state.site.description).not.toBe('Mine');
    expect(s.state.site.baseUrl).toBe('https://ai.example');
  });

  it('waits for the request to end when the engine would carry the edit into something the run changed', async () => {
    const { s } = await make();
    const header = brandPlacements(s.state).find((p) => p.part === 'header')!.node;
    const setName = (value: string): EditOperation => ({ type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: header.id, prop: 'siteName', value });
    // The header had a name of its own before the request; the AI put the site's name back in it.
    expect((await s.apply({ operations: [setName('Studio')] }, { label: 'Header name' })).ok).toBe(true);
    expect(await s.beginRun('run_q')).toBeNull();
    expect((await s.apply({ operations: [setName('Persist')] }, { label: 'AI', source: 'ai', runId: 'run_q', history: false })).ok).toBe(true);
    // Renaming the site renames the header with it now, but not where the request started.
    const rename: EditOperation[] = [{ type: 'site.update', name: 'Northstar' }];
    expect(applyOperations(s.state, rename).state.site.shell.header.nodes[header.id]).toMatchObject({ props: { siteName: 'Northstar' } });
    const r = await s.apply({ operations: rename }, { label: 'Rename site', source: 'user', asking: { runId: 'run_q', base: seen(s.state, rename) } });
    expect(r).toMatchObject({ ok: false, error: { code: 'CONFLICT', details: { held: 'differs' } } });
    expect(s.state.site.name).toBe('Persist');
  });

  it('saves an edit of one list item beside the run’s edit of another in the same list', async () => {
    const { s } = await make();
    const header = brandPlacements(s.state).find((p) => p.part === 'header')!.node;
    const links = header.props.links as Array<{ id: string; label: string }>;
    const label = (i: number, value: string): EditOperation => ({ type: 'instance.setProp', owner: { kind: 'shell', id: 'header' }, nodeId: header.id, prop: 'links', itemId: links[i].id, field: 'label', value });
    expect(await s.beginRun('run_q')).toBeNull();
    expect((await s.apply({ operations: [label(0, 'Start')] }, { label: 'AI', source: 'ai', runId: 'run_q', history: false })).ok).toBe(true);
    const mine = [label(1, 'Who we are')];
    expect((await s.apply({ operations: mine }, { label: 'Rename link', source: 'user', asking: { runId: 'run_q', base: seen(s.state, mine) } })).ok).toBe(true);
    expect(await s.abortRun()).toEqual({ restored: true });
    const after = s.state.site.shell.header.nodes[header.id] as unknown as { props: { links: Array<{ label: string }> } };
    expect(after.props.links.map((l) => l.label).slice(0, 2)).toEqual([links[0].label, 'Who we are']);
  });

  it('never counts a save turned away at the last moment as the run’s own writing', async () => {
    const { dir, s, typed } = await waitingRun();
    // The very file the save would write is saved outside the app just after its journal is in place.
    const target = stateToDocs(applyOperations(s.state, urlEdit()).state).get(SITE)!;
    const session = s as unknown as { placeJournal: (...a: unknown[]) => Promise<void> };
    const place = session.placeJournal.bind(s);
    const spy = vi.spyOn(session, 'placeJournal').mockImplementation(async (...a: unknown[]) => {
      await place(...a);
      writeFileSync(join(dir, SITE), target);
    });
    expect(await saveUrl(s, typed)).toMatchObject({ ok: false });
    spy.mockRestore();
    expect(existsSync(join(dir, '.siteorigin/journal.json'))).toBe(false);
    // The run goes on writing elsewhere, so its marker is written again, and then the app goes down.
    const later = await s.apply({ operations: [{ type: 'page.update', pageId: s.state.site.homePageId, title: 'AI home' }] }, { label: 'AI', source: 'ai', runId: 'run_q', history: false });
    expect(later.ok).toBe(true);
    await s.releaseLock();
    const again = await reopen(dir);
    // The file saved outside the app is never taken for the run's and silently rolled back.
    expect(again.conflicts.map((c) => c.path)).toContain(SITE);
  });

  it('sets aside a save whose journal carries a marker that does not cover the run, undoing the run without it', async () => {
    const { dir, s, typed, baseUrl } = await waitingRun();
    expect((await s.apply({ operations: [{ type: 'page.create', title: 'AI page' }] }, { label: 'AI', source: 'ai', runId: 'run_q', history: false })).ok).toBe(true);
    const session = s as unknown as { placeJournal: (j: { runMarker?: { id: string; paths: Record<string, unknown> } }, ...rest: unknown[]) => Promise<void> };
    const place = session.placeJournal.bind(s);
    // The journal lands with its marker missing the AI's new page, and the app goes down at once.
    vi.spyOn(session, 'placeJournal').mockImplementation(async (j, ...rest) => {
      const paths = Object.fromEntries(Object.entries(j.runMarker!.paths).filter(([p]) => p === SITE));
      await place({ ...j, runMarker: { ...j.runMarker!, paths } }, ...rest);
      throw new Error('injected crash');
    });
    await saveUrl(s, typed).catch(() => undefined);
    vi.restoreAllMocks();
    await s.releaseLock();
    const again = await reopen(dir);
    expect(again.conflicts).toEqual([]);
    expect(again.state.site.name).toBe('Persist');
    expect(again.state.site.baseUrl).toBe(baseUrl);
    expect(Object.values(again.state.pages).map((p) => p.title)).not.toContain('AI page');
    expect(again.historyInfo().entries).toEqual([]);
    expect(existsSync(join(dir, '.siteorigin/sessions/active-run.json'))).toBe(false);
  });

  it('saves an edit the run left alone without making the run look changed', async () => {
    const { s } = await make();
    const typed = seen(s.state, urlEdit());
    expect(await s.beginRun('run_q')).toBeNull();
    expect((await saveUrl(s, typed)).ok).toBe(true);
    expect(s.runChanged()).toBe(false);
    expect(await s.completeRun('AI: nothing')).toBe(false);
    expect(s.historyInfo().entries.map((e) => e.label)).toEqual(['Update site settings']);
  });

  it('waits for the request to end when the edit is on something the run made', async () => {
    const { s } = await waitingRun();
    expect((await s.apply({ operations: [{ type: 'page.create', title: 'AI page' }] }, { label: 'AI', source: 'ai', runId: 'run_q', history: false })).ok).toBe(true);
    const page = Object.values(s.state.pages).find((p) => p.title === 'AI page')!;
    const rename: EditOperation[] = [{ type: 'page.update', pageId: page.id, title: 'My title' }];
    const r = await s.apply({ operations: rename }, { label: 'Rename page', source: 'user', asking: { runId: 'run_q', base: seen(s.state, rename) } });
    expect(r).toMatchObject({ ok: false, error: { code: 'CONFLICT', details: { held: 'differs' } } });
    expect(r.error!.message).toMatch(/AI made the page/);
    expect(s.state.pages[page.id].title).toBe('AI page');
  });

  it('is refused for another request, after the request has ended, and for an edit that is no typed field', async () => {
    const { s, typed } = await waitingRun();
    expect(await s.apply({ operations: urlEdit() }, { label: 'x', source: 'user', asking: { runId: 'run_other', base: typed } })).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(await s.apply({ operations: [{ type: 'page.create', title: 'Mine' }] }, { label: 'x', source: 'user', asking: { runId: 'run_q', base: [null] } })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(await s.apply({ operations: urlEdit() }, { label: 'x', source: 'user', asking: { runId: 'run_q', base: [...typed, null] } })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    // An ordinary edit still waits for the AI.
    expect(await s.apply({ operations: [{ type: 'site.update', baseUrl: URL }] }, { label: 'x', source: 'user' })).toMatchObject({ ok: false, error: { code: 'BUSY' } });
    await s.abortRun();
    expect(await saveUrl(s, typed)).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
  });
});
