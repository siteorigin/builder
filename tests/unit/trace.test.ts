import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startTrace, stopTrace, trace } from '../../src/main/trace';

const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'trace-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  stopTrace();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const lines = (file: string) => readFileSync(file, 'utf8').split('\n').filter(Boolean);

describe('the app trace (logs/trace.log)', () => {
  it('writes nothing before it is started', () => {
    const file = join(scratch(), 'logs', 'trace.log');
    trace('open', 'asked');
    expect(existsSync(file)).toBe(false);
  });

  it('writes each step under its area, timed from the launch', () => {
    const file = join(scratch(), 'logs', 'trace.log');
    startTrace(file);
    trace('open', 'asked to open', '/projects/site');
    const written = lines(file);
    expect(written[0]).toMatch(/^\S+Z \[trace\] \+0ms trace: started$/);
    expect(written[1]).toMatch(/^\S+Z \[trace\] \+\d+ms open: asked to open \/projects\/site$/);
  });

  it('starts afresh on each launch, keeping only the launch before', () => {
    const dir = scratch();
    const file = join(dir, 'trace.log');
    writeFileSync(`${file}.1`, 'two launches ago\n');
    startTrace(file);
    trace('open', 'first launch');
    startTrace(file);
    trace('open', 'second launch');
    expect(lines(file).slice(1).map((l) => l.replace(/^.*ms /, ''))).toEqual(['open: second launch']);
    expect(lines(`${file}.1`).slice(1).map((l) => l.replace(/^.*ms /, ''))).toEqual(['open: first launch']);
  });

  it('moves the file aside past its size cap', () => {
    const file = join(scratch(), 'trace.log');
    startTrace(file, { maxBytes: 400 });
    for (let i = 0; i < 20; i++) trace('ipc', `step ${i}`, 'x'.repeat(40));
    expect(readFileSync(file, 'utf8').length).toBeLessThanOrEqual(400);
    expect(lines(file).at(-1)).toContain('step 19');
    expect(existsSync(`${file}.1`)).toBe(true);
  });
});
