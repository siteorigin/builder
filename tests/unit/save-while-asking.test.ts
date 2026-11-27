import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarterState } from '@catalogue/starters';
import type { EditOperation } from '@shared/ops';
import type { ProjectState } from '@shared/types';
import { ProjectSession } from '../../src/main/project/session';
import { readFields } from '../../src/renderer/src/lib/held';

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
    // Undoing the AI's step keeps the author's edit; undoing the author's then takes the URL back.
    expect((await s.undo()).ok).toBe(true);
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
    await s.releaseLock();
    const again = await reopen(dir);
    expect(again.conflicts).toEqual([]);
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

  it('waits for the request to end when the edit is on something the run made', async () => {
    const { s } = await waitingRun();
    expect((await s.apply({ operations: [{ type: 'page.create', title: 'AI page' }] }, { label: 'AI', source: 'ai', runId: 'run_q', history: false })).ok).toBe(true);
    const page = Object.values(s.state.pages).find((p) => p.title === 'AI page')!;
    const rename: EditOperation[] = [{ type: 'page.update', pageId: page.id, title: 'My title' }];
    const r = await s.apply({ operations: rename }, { label: 'Rename page', source: 'user', asking: { runId: 'run_q', base: seen(s.state, rename) } });
    expect(r).toMatchObject({ ok: false, error: { code: 'CONFLICT', details: { held: 'differs' } } });
    expect(s.state.pages[page.id].title).toBe('AI page');
  });

  it('is refused for another request, after the request has ended, and for an edit that is no typed field', async () => {
    const { s, typed } = await waitingRun();
    expect(await s.apply({ operations: urlEdit() }, { label: 'x', source: 'user', asking: { runId: 'run_other', base: typed } })).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    expect(await s.apply({ operations: [{ type: 'page.create', title: 'Mine' }] }, { label: 'x', source: 'user', asking: { runId: 'run_q', base: [null] } })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    // An ordinary edit still waits for the AI.
    expect(await s.apply({ operations: [{ type: 'site.update', baseUrl: URL }] }, { label: 'x', source: 'user' })).toMatchObject({ ok: false, error: { code: 'BUSY' } });
    await s.abortRun();
    expect(await saveUrl(s, typed)).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
  });
});
