import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearTrace, startTrace, stopTrace, trace, traced, tracing } from '../../src/main/trace';

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
    vi.useFakeTimers({ now: new Date('2026-11-28T15:44:08.000Z') });
    try {
      const file = join(scratch(), 'logs', 'trace.log');
      startTrace(file);
      vi.setSystemTime(new Date('2026-11-28T15:44:09.234Z'));
      trace('open', 'asked to open', '/projects/site');
      expect(lines(file)).toEqual(['2026-11-28T15:44:08.000Z [trace] +0ms trace: started', '2026-11-28T15:44:09.234Z [trace] +1234ms open: asked to open /projects/site']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries on after what this launch wrote when tracing is turned on again', () => {
    const file = join(scratch(), 'trace.log');
    startTrace(file);
    trace('open', 'before');
    stopTrace();
    startTrace(file, { resumed: true });
    trace('open', 'after');
    expect(lines(file).map((l) => l.replace(/^.*ms /, ''))).toEqual(['trace: started', 'open: before', 'trace: resumed', 'open: after']);
  });

  it('never throws on what it is given to say', () => {
    const odd = Object.create(null) as object;
    expect(traced(odd)).toBe('an error that cannot be shown');
    expect(traced(new Error('boom'))).toBe('boom');
  });

  it('holds one launch only: a new start removes the last trace and the part of it moved aside', () => {
    const dir = scratch();
    const file = join(dir, 'trace.log');
    startTrace(file, { maxBytes: 300 });
    for (let i = 0; i < 10; i++) trace('open', `first launch ${i}`, 'x'.repeat(40));
    expect(existsSync(`${file}.1`)).toBe(true);
    startTrace(file);
    trace('open', 'second launch');
    expect(lines(file).slice(1).map((l) => l.replace(/^.*ms /, ''))).toEqual(['open: second launch']);
    expect(existsSync(`${file}.1`)).toBe(false);
  });

  it('clears the last launch\'s trace for a launch that does not trace', () => {
    const dir = scratch();
    const file = join(dir, 'trace.log');
    writeFileSync(file, 'last launch\n');
    writeFileSync(`${file}.1`, 'last launch, earlier\n');
    clearTrace(file);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.1`)).toBe(false);
    trace('open', 'not traced');
    expect(existsSync(file)).toBe(false);
  });

  it('stops writing once stopped', () => {
    const file = join(scratch(), 'trace.log');
    startTrace(file);
    expect(tracing()).toBe(true);
    stopTrace();
    trace('open', 'after the stop');
    expect(tracing()).toBe(false);
    expect(lines(file)).toHaveLength(1);
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
