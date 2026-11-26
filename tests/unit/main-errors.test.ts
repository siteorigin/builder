/**
 * An error nothing in the main process caught is reported in the app's own words (#886): one question at a time once
 * the app is running (Quit runs the normal quit), an error box and exit before it is ready, and the reporter never
 * throws, even when reporting fails.
 */
import { describe, expect, it } from 'vitest';
import { createMainErrorReporter, errorText, mainErrorReport, type MainErrorOptions } from '../../src/main/main-errors';

function rig(over: Partial<MainErrorOptions> = {}) {
  const calls: string[] = [];
  const answers: ((button: number) => void)[] = [];
  const asked: Parameters<MainErrorOptions['ask']>[0][] = [];
  const report = createMainErrorReporter({
    ready: () => true,
    log: () => calls.push('log'),
    ask: (r) => {
      asked.push(r);
      return new Promise<number>((answer) => answers.push(answer));
    },
    errorBox: (title) => calls.push(`box:${title}`),
    quit: () => calls.push('quit'),
    exit: (code) => calls.push(`exit:${code}`),
    ...over
  });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { report, calls, answers, asked, settle };
}

describe('main-process errors (#886)', () => {
  it('asks in its own words, and quits the normal way when Quit is chosen', async () => {
    const { report, calls, answers, asked, settle } = rig();
    report(new Error('EPIPE: broken pipe, write'));
    expect(asked).toHaveLength(1);
    expect(asked[0].message).toBe('SiteOrigin Builder ran into a problem');
    // Plain words first, the technical message last, and no promise that quitting saves.
    expect(asked[0].detail).toMatch(/^Your saved work is safe\. Quit and open SiteOrigin Builder again/);
    expect(asked[0].detail).toMatch(/\n\nDetails: EPIPE: broken pipe, write$/);
    expect(asked[0].detail).not.toMatch(/saves/);
    expect(asked[0].detail).not.toMatch(/\n\s+at /);
    expect(asked[0].buttons[asked[0].defaultId]).toBe('Quit');
    expect(asked[0].buttons[asked[0].cancelId]).toBe('Keep Working');
    answers[0](0);
    await settle();
    expect(calls).toEqual(['log', 'quit']);
  });

  it('keeps running on Keep Working, and asks again for a later error', async () => {
    const { report, calls, answers, asked, settle } = rig();
    report(new Error('first'));
    // A second error while the question is open is only logged.
    report(new Error('second'));
    expect(asked).toHaveLength(1);
    answers[0](1);
    await settle();
    expect(calls).toEqual(['log', 'log']);
    report('third');
    expect(asked).toHaveLength(2);
    expect(asked[1].detail).toMatch(/\n\nDetails: third$/);
  });

  it('says the app could not start, and exits, before it is ready', () => {
    const { report, calls, asked } = rig({ ready: () => false });
    report(new Error('Cannot find module'));
    expect(asked).toHaveLength(0);
    expect(calls).toEqual(['log', 'box:SiteOrigin Builder could not start', 'exit:1']);
  });

  it('never throws when reporting fails', async () => {
    const failing = rig({
      ask: () => {
        throw new Error('no dialog');
      }
    });
    expect(() => failing.report(new Error('x'))).not.toThrow();
    const rejecting = rig({ ask: () => Promise.reject(new Error('no dialog')), log: () => { throw new Error('no console'); } });
    expect(() => rejecting.report(new Error('x'))).not.toThrow();
    await rejecting.settle();
    const box = rig({ ready: () => false, errorBox: () => { throw new Error('no box'); } });
    expect(() => box.report(new Error('x'))).not.toThrow();
    expect(box.calls).toEqual(['log', 'log', 'exit:1']);
  });

  it('asks again after a question that could not be shown, and survives a Quit that throws', async () => {
    let shown = 0;
    const flaky = rig({
      ask: () => {
        shown++;
        if (shown === 1) throw new Error('no dialog');
        return Promise.resolve(0);
      },
      quit: () => {
        throw new Error('cannot quit');
      }
    });
    flaky.report(new Error('first'));
    flaky.report(new Error('second'));
    expect(shown).toBe(2);
    await flaky.settle();
    // A reporter whose ready check itself throws treats the app as not started.
    const broken = rig({
      ready: () => {
        throw new Error('no app');
      },
      exit: () => {
        throw new Error('cannot exit');
      }
    });
    expect(() => broken.report(new Error('x'))).not.toThrow();
    expect(broken.calls).toEqual(['log', 'box:SiteOrigin Builder could not start', 'log']);
  });

  it('puts the error and a way forward in the startup box', () => {
    let content = '';
    const { report } = rig({ ready: () => false, errorBox: (_t, c) => void (content = c) });
    report(new Error('Cannot find module'));
    expect(content).toBe(
      'Your projects are safe. Try opening SiteOrigin Builder again. If it still does not start, reinstall it, and report the problem at github.com/siteorigin/builder/issues.\n\nDetails: Cannot find module'
    );
  });

  it('describes whatever was thrown in one line', () => {
    expect(errorText(new TypeError('x is not a function'))).toBe('x is not a function');
    expect(errorText(Object.assign(new Error(''), { name: 'AbortError' }))).toBe('AbortError');
    expect(errorText({ code: 'E1' })).toBe('{"code":"E1"}');
    expect(errorText(undefined)).toBe('undefined');
    expect(errorText('')).toBe('An unknown error.');
    expect(errorText(Object.create(null))).toBe('{}');
    const unspeakable = Object.assign(Object.create(null), {
      toJSON() {
        throw new Error('no');
      }
    });
    expect(errorText(unspeakable)).toBe('An unknown error.');
    expect(mainErrorReport(new Error('boom')).detail.endsWith('\n\nDetails: boom')).toBe(true);
  });

  it('says what fixes a full disk, which a restart alone does not', () => {
    const full = Object.assign(new Error("ENOSPC: no space left on device, write '/sites/home.json'"), { code: 'ENOSPC' });
    expect(mainErrorReport(full).detail).toMatch(/^Your saved work is safe, but the disk is full, so new changes cannot be saved\..*free up disk space/);
    expect(mainErrorReport(new Error('boom')).detail).not.toMatch(/disk is full/);
  });
});
