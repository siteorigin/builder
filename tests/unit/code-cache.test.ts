/**
 * The editor window keeps compiled code from a script's first run until this build's editor has run once, so the
 * second launch after an update reuses it (#958), and returns to Chromium's default after that, so the preview's
 * scripts (a new dev server port each launch) are not stored every launch.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CODE_CACHE_NOTE, createEditorCodeCache } from '../../src/main/code-cache';

const dirs: string[] = [];
const profile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'so-code-cache-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('the editor window’s code cache policy', () => {
  it('keeps code from the first run until the build’s editor has run, then uses Chromium’s default', async () => {
    const dir = profile();
    const first = createEditorCodeCache(() => dir, 'build A');
    expect(await first.policy()).toBe('bypassHeatCheck');
    await first.ran();
    // A window made later in the same launch (macOS reopens one), and the next launch of the build.
    expect(await first.policy()).toBe('code');
    expect(await createEditorCodeCache(() => dir, 'build A').policy()).toBe('code');
    expect(readFileSync(join(dir, CODE_CACHE_NOTE), 'utf8')).toBe('build A');
  });

  it('keeps code from the first run again for another build, and once the cache is cleared', async () => {
    const dir = profile();
    await createEditorCodeCache(() => dir, 'build A').ran();
    // An update: the new build's scripts have never run.
    expect(await createEditorCodeCache(() => dir, 'build B').policy()).toBe('bypassHeatCheck');
    // Clearing Chromium's code cache clears the note with it.
    rmSync(join(dir, 'Code Cache'), { recursive: true, force: true });
    expect(await createEditorCodeCache(() => dir, 'build A').policy()).toBe('bypassHeatCheck');
  });

  it('asks where the profile is only when it needs it', async () => {
    const dir = profile();
    let at = join(dir, 'not yet');
    const cache = createEditorCodeCache(() => at, 'build A');
    at = join(dir, 'profile');
    await cache.ran();
    expect(readFileSync(join(at, CODE_CACHE_NOTE), 'utf8')).toBe('build A');
  });

  it('a note it cannot write only means the next launch keeps code from the first run again', async () => {
    const dir = profile();
    // A file where the folder should be.
    writeFileSync(join(dir, 'Code Cache'), '');
    const cache = createEditorCodeCache(() => dir, 'build A');
    await expect(cache.ran()).resolves.toBeUndefined();
    expect(await createEditorCodeCache(() => dir, 'build A').policy()).toBe('bypassHeatCheck');
  });
});
