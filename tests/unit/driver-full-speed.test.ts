// A test app on Windows is kept out of power throttling (tests/driver/full-speed.ts): its window is never shown, and
// Windows would otherwise slow its main process and helpers to a crawl.
import { describe, expect, it } from 'vitest';
import { fullSpeedScript, keepAtFullSpeed } from '../driver/full-speed';

describe('keeping a test app at full speed', () => {
  it('opts the app and every process under it out of throttling, until the app has gone', () => {
    const script = fullSpeedScript(4242);
    expect(script).toContain('$root = 4242');
    // Execution speed is controlled, and not throttled.
    expect(script).toMatch(/ControlMask = 1; s\.StateMask = 0;/);
    expect(script).toContain('SetProcessInformation(h, 4,');
    // Only processes started after their parent count as under it, so a reused ID is never touched.
    expect(script).toContain('$p.CreationDate -ge $byId[$at].CreationDate');
    expect(script).toContain('while (Get-Process -Id $root)');
  });

  it('takes only a process ID', () => {
    for (const pid of [0, -1, 1.5, Number.NaN]) expect(() => fullSpeedScript(pid)).toThrow(/Not a process ID/);
  });

  it('does nothing outside Windows', () => {
    const stop = keepAtFullSpeed(4242, 'darwin');
    expect(() => stop()).not.toThrow();
    expect(keepAtFullSpeed(4242, 'linux')).toBeTypeOf('function');
  });
});
