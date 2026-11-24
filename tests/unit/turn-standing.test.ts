/**
 * Where an AI turn's change stands (issue 276): History says it while it holds the turn's step, and remembers whether
 * the step was applied or undone when it lets it go, so a chat turn never claims the opposite of the site.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStarterState } from '@catalogue/starters';
import { SCHEMA_VERSION } from '@shared/types';
import { runStanding } from '@shared/turns';
import { ProjectSession } from '../../src/main/project/session';

const dirs: string[] = [];
const open: ProjectSession[] = [];
afterEach(async () => {
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
