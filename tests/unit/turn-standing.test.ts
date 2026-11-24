/**
 * Where an AI turn's change stands (issue 276): History says it while it holds the turn's step, and remembers whether
 * the step was applied or undone when it lets it go, so a chat turn never claims the opposite of the site.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, promises as fsp, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarterState } from '@catalogue/starters';
import { SCHEMA_VERSION } from '@shared/types';
import { runStanding } from '@shared/turns';
import { ProjectSession } from '../../src/main/project/session';

const dirs: string[] = [];
const open: ProjectSession[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

async function make() {
  const dir = mkdtempSync(join(tmpdir(), 'so-turns-'));
  dirs.push(dir);
  const s = await ProjectSession.create(dir, createStarterState('business', 'Turns', false));
  open.push(s);
  return { dir, s };
}
async function reopen(dir: string) {
  const s = await ProjectSession.open(dir, 'test');
  open.push(s);
  return s;
}
async function ok(p: Promise<{ ok: boolean; error?: { message: string } }>) {
  const r = await p;
  expect(r.error?.message).toBeUndefined();
  expect(r.ok).toBe(true);
}
/** One AI run that renames the site: one History step carrying the run. */
async function ai(s: ProjectSession, runId: string, name: string) {
  expect(await s.beginRun(runId)).toBeNull();
  await ok(s.apply({ operations: [{ type: 'site.update', name }] }, { label: 'AI', source: 'ai', runId, history: false }));
  expect(await s.completeRun(`AI: rename to ${name}`)).toBe(true);
}
const edit = (s: ProjectSession, name: string) => ok(s.apply({ operations: [{ type: 'site.update', name }] }, { label: `Rename to ${name}` }));
const standing = (s: ProjectSession, runId: string) => runStanding(runId, s.historyInfo());

describe('AI turn standing in History (issue 276)', () => {
  it('follows Undo and Redo from any source, and keeps an undone turn undone once a new edit drops its step', async () => {
    const { dir, s } = await make();
    await ai(s, 'run_a', 'Reading nook');
    expect(standing(s, 'run_a')).toBe('applied');
    await ok(s.undoGroup('run_a'));
    expect(standing(s, 'run_a')).toBe('undone');
    await ok(s.redo());
    expect(standing(s, 'run_a')).toBe('applied');
    await ok(s.undo());
    // A new edit replaces the redo steps: the run's step goes, and it went undone.
    await edit(s, 'Kitchen');
    expect(s.historyInfo().entries.some((e) => e.runId === 'run_a')).toBe(false);
    expect(standing(s, 'run_a')).toBe('undone');
    expect(s.state.site.name).toBe('Kitchen');
    await s.close();
    const again = await reopen(dir);
    expect(standing(again, 'run_a')).toBe('undone');
  });

  it('remembers an applied turn as applied when the step count limit drops it', async () => {
    const { s } = await make();
    await ai(s, 'run_old', 'First');
    for (let i = 0; i < 100; i++) await edit(s, `Edit ${i}`);
    expect(s.historyInfo().entries.some((e) => e.runId === 'run_old')).toBe(false);
    expect(standing(s, 'run_old')).toBe('applied');
  }, 60_000);

  it('remembers where a turn stood when the size limit trims either end of History', async () => {
    const applied = await make();
    await ai(applied.s, 'run_kept', 'Kept');
    await edit(applied.s, 'Later');
    applied.s.historyByteLimit = 1;
    await applied.s.collectGarbage();
    expect(applied.s.historyInfo().entries).toHaveLength(1);
    expect(standing(applied.s, 'run_kept')).toBe('applied');
    await applied.s.close();
    expect(standing(await reopen(applied.dir), 'run_kept')).toBe('applied');

    // With nothing applied, the far end of redo goes first.
    const undone = await make();
    await edit(undone.s, 'First');
    await ai(undone.s, 'run_redo', 'Second');
    await ok(undone.s.undo());
    await ok(undone.s.undo());
    undone.s.historyByteLimit = 1;
    await undone.s.collectGarbage();
    expect(undone.s.historyInfo().entries).toHaveLength(1);
    expect(standing(undone.s, 'run_redo')).toBe('undone');
  });

  it('keeps where each turn stood when History from an older format is dropped on opening', async () => {
    const { dir, s } = await make();
    await ai(s, 'run_on', 'On');
    await ai(s, 'run_off', 'Off');
    await ok(s.undoGroup('run_off'));
    await s.close();
    const file = join(dir, '.siteorigin/history/history.json');
    const h = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...h, schemaVersion: SCHEMA_VERSION - 1, droppedRuns: { run_gone: 'undone', run_bad: 'maybe' } }));
    const again = await reopen(dir);
    expect(again.historyInfo().entries).toEqual([]);
    expect(again.historyInfo().droppedRuns).toEqual({ run_gone: 'undone', run_on: 'applied', run_off: 'undone' });
    expect(again.state.site.name).toBe('On');
  });

  it('keeps History as saved when the trimmed History cannot be saved', async () => {
    const { s } = await make();
    await ai(s, 'run_kept', 'Kept');
    await edit(s, 'Later');
    const real = fsp.rename.bind(fsp);
    vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to).endsWith('history.json')) throw Object.assign(new Error('injected failure'), { code: 'EIO' });
      return real(from, to);
    });
    s.historyByteLimit = 1;
    await s.collectGarbage();
    expect(s.historyInfo().entries.map((e) => e.runId ?? null)).toEqual(['run_kept', null]);
    expect(s.historyInfo().droppedRuns).toBeUndefined();
    vi.restoreAllMocks();
    // Every step the saved History names can still be undone: its versions were kept.
    await ok(s.undo());
    await ok(s.undoGroup('run_kept'));
    expect(s.state.site.name).toBe('Turns');
  });

  it('carries over only what an older History says for sure', async () => {
    const { dir, s } = await make();
    await s.close();
    const file = join(dir, '.siteorigin/history/history.json');
    const step = (runId: string) => ({ id: runId, label: 'AI', source: 'ai', time: '', revision: 1, docs: {}, runId });
    const read = async (h: unknown) => {
      writeFileSync(file, JSON.stringify(h));
      const again = await reopen(dir);
      const dropped = again.historyInfo().droppedRuns;
      await again.close();
      return dropped;
    };
    // A malformed step is skipped where it stands: the one after the undo position is still undone.
    expect(await read({ schemaVersion: SCHEMA_VERSION - 1, entries: [null, step('run_b')], cursor: 1 })).toEqual({ run_b: 'undone' });
    // The first format had no version, and is older.
    expect(await read({ entries: [step('run_a'), step('run_b')], cursor: 1 })).toEqual({ run_a: 'applied', run_b: 'undone' });
    // An undo position that does not fit, or a newer format, says nothing sure.
    expect(await read({ schemaVersion: SCHEMA_VERSION - 1, entries: [step('run_a')], cursor: 3 })).toBeUndefined();
    expect(await read({ schemaVersion: SCHEMA_VERSION - 1, entries: [step('run_a')] })).toBeUndefined();
    expect(await read({ schemaVersion: SCHEMA_VERSION + 1, entries: [step('run_a')], cursor: 1 })).toBeUndefined();
  });

  it('lets go of the oldest notes past its limit', async () => {
    const { dir, s } = await make();
    await s.close();
    const file = join(dir, '.siteorigin/history/history.json');
    const entries = Array.from({ length: 205 }, (_, i) => ({ id: `h${i}`, label: 'AI', source: 'ai', time: '', revision: i, docs: {}, runId: `run_${i}` }));
    writeFileSync(file, JSON.stringify({ schemaVersion: SCHEMA_VERSION - 1, entries, cursor: 205 }));
    const again = await reopen(dir);
    const kept = Object.keys(again.historyInfo().droppedRuns ?? {});
    expect(kept).toHaveLength(200);
    expect(kept[0]).toBe('run_5');
    expect(kept.at(-1)).toBe('run_204');
  });
});
