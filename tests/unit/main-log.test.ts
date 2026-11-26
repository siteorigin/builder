import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureMainErrors, createMainLog } from '../../src/main/main-log';

const dirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'main-log-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const now = () => new Date('2026-11-26T14:03:27.512Z');

describe('the main process log (#887)', () => {
  it('appends timestamped entries to a file it makes, errors with their stack', () => {
    const file = join(scratch(), 'logs', 'main.log');
    const log = createMainLog({ file, now });
    log.write('start', 'SiteOrigin Builder 0.1.0 (a1b2c3d, built 2026-11-26 14:03 UTC)');
    log.write('error', 'The window could not be opened:', new Error('boom'));
    const lines = readFileSync(file, 'utf8');
    expect(lines.startsWith('2026-11-26T14:03:27.512Z [start] SiteOrigin Builder 0.1.0 (a1b2c3d, built 2026-11-26 14:03 UTC)\n')).toBe(true);
    expect(lines).toContain('2026-11-26T14:03:27.512Z [error] The window could not be opened: Error: boom\n    at ');
  });

  it('keeps what an earlier launch wrote: a new launch appends, never truncates', () => {
    const file = join(scratch(), 'main.log');
    createMainLog({ file, now }).write('start', 'build A');
    createMainLog({ file, now }).write('uncaught', 'build A failed');
    const later = createMainLog({ file, now });
    later.write('start', 'build B');
    expect(later.ensure()).toBe(true);
    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => l.slice(25))).toEqual(['[start] build A', '[uncaught] build A failed', '[start] build B']);
  });

  it('moves the file aside past its cap, keeping one earlier file, and cuts an overlong entry', () => {
    const file = join(scratch(), 'main.log');
    const log = createMainLog({ file, now, maxBytes: 120, maxEntry: 50, header: () => 'SiteOrigin Builder 0.1.0 (a1b2c3d)' });
    log.write('error', `${'x'.repeat(49)}z${'x'.repeat(450)}`);
    expect(readFileSync(file, 'utf8')).toBe(`2026-11-26T14:03:27.512Z [error] ${'x'.repeat(49)}z… (450 more characters)\n`);
    log.write('error', 'second');
    expect(readFileSync(`${file}.1`, 'utf8')).toContain('more characters');
    // The file started past the cap names the build first.
    expect(readFileSync(file, 'utf8')).toBe('2026-11-26T14:03:27.512Z [build] SiteOrigin Builder 0.1.0 (a1b2c3d)\n2026-11-26T14:03:27.512Z [error] second\n');
    log.write('error', 'y'.repeat(200));
    expect(readFileSync(`${file}.1`, 'utf8')).toMatch(/\[error\] second\n$/);
    expect(readFileSync(file, 'utf8')).toMatch(/^.{24} \[build\] .*\n.{24} \[error\] y{50}… \(150 more characters\)\n$/);
  });

  it('keeps writing past the cap when the file cannot move aside, rather than dropping entries', () => {
    const file = join(scratch(), 'main.log');
    // A folder where the earlier file goes: the move aside fails, as it does on Windows while the file is held open.
    mkdirSync(join(`${file}.1`, 'busy'), { recursive: true });
    const log = createMainLog({ file, now, maxBytes: 60 });
    log.write('error', 'first entry, filling the file');
    log.write('error', 'second entry');
    expect(readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => l.slice(25))).toEqual(['[error] first entry, filling the file', '[error] second entry']);
  });

  it('never throws when the file cannot be written, and says so when it cannot be made', () => {
    const dir = scratch();
    // A file where the log's folder should be.
    writeFileSync(join(dir, 'logs'), '');
    const log = createMainLog({ file: join(dir, 'logs', 'main.log'), now });
    expect(() => log.write('error', 'lost')).not.toThrow();
    expect(log.ensure()).toBe(false);
  });

  it('makes an empty file to reveal before anything is logged', () => {
    const file = join(scratch(), 'logs', 'main.log');
    const log = createMainLog({ file, now });
    expect(existsSync(file)).toBe(false);
    expect(log.ensure()).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('');
  });

  it('records console errors and warnings, uncaught exceptions and process warnings, still printing them, until undone', async () => {
    const file = join(scratch(), 'main.log');
    const log = createMainLog({ file, now });
    const error = vi.fn();
    const warn = vi.fn();
    const con = { error, warn } as unknown as Console;
    const emitter = new EventEmitter();
    const proc = emitter as unknown as NodeJS.Process;
    // Node's own listener, there from the start, prints each warning through console.error.
    const nodePrints = (w: Error) => con.error(`(node) ${w.name}: ${w.message}`);
    emitter.on('warning', nodePrints);
    const undo = captureMainErrors(log, { console: con, process: proc });
    con.error('could not save', 42);
    con.warn('slow');
    emitter.emit('uncaughtExceptionMonitor', new Error('crashed'), 'uncaughtException');
    const w = new Error('a promise was rejected');
    w.name = 'UnhandledPromiseRejectionWarning';
    emitter.emit('warning', w);
    await Promise.resolve();
    con.error('later');
    expect(error).toHaveBeenCalledWith('could not save', 42);
    expect(warn).toHaveBeenCalledWith('slow');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('[error] could not save 42\n');
    expect(text).toContain('[warn] slow\n');
    expect(text).toContain('[uncaught] uncaughtException: Error: crashed');
    expect(text).toContain('[warn] UnhandledPromiseRejectionWarning: a promise was rejected');
    // Node's printing of that warning is not recorded a second time; the next error is.
    expect(error).toHaveBeenCalledWith('(node) UnhandledPromiseRejectionWarning: a promise was rejected');
    expect(text).not.toContain('(node)');
    expect(text).toContain('[error] later\n');
    expect(text.match(/^2026-11-26T14:03:27\.512Z \[/gm)).toHaveLength(5);

    undo();
    expect(con.error).toBe(error);
    expect(con.warn).toBe(warn);
    expect(emitter.listenerCount('uncaughtExceptionMonitor')).toBe(0);
    // Only the capture's own listener goes; Node's stays.
    expect(emitter.listeners('warning')).toEqual([nodePrints]);
    con.error('after');
    expect(readFileSync(file, 'utf8')).not.toContain('after');
  });
});
