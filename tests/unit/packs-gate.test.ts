import { describe, expect, it } from 'vitest';
import { createPacksGate } from '../../src/main/packs/gate';

/** A verification the test finishes, counting how often it was started. */
function held() {
  let finish!: () => void;
  let fail!: (e: Error) => void;
  let starts = 0;
  const load = () => {
    starts += 1;
    return new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
  };
  return { load, finish: () => finish(), fail: (e: Error) => fail(e), starts: () => starts };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('the theme packs gate', () => {
  it('holds a request until the packs are verified, then runs it once', async () => {
    const v = held();
    const gate = createPacksGate(v.load);
    const ran: string[] = [];
    const answer = gate.after(
      () => undefined,
      () => {
        ran.push('catalogue');
        return 'the catalogue';
      }
    );
    await tick();
    // Nothing that reads a pack runs while verification is under way.
    expect(ran).toEqual([]);
    expect(gate.verified).toBe(false);
    v.finish();
    await expect(answer).resolves.toBe('the catalogue');
    expect(ran).toEqual(['catalogue']);
    expect(gate.verified).toBe(true);
  });

  it('verifies once, however many requests and windows ask, and runs waiting requests in the order they came', async () => {
    const v = held();
    const gate = createPacksGate(v.load);
    const first = gate.verify();
    const again = gate.verify();
    const entered: number[] = [];
    const waiting = [1, 2, 3].map((n) =>
      gate.after(
        () => undefined,
        () => {
          entered.push(n);
          return n;
        }
      )
    );
    expect(again).toBe(first);
    v.finish();
    await expect(Promise.all(waiting)).resolves.toEqual([1, 2, 3]);
    expect(entered).toEqual([1, 2, 3]);
    expect(v.starts()).toBe(1);
  });

  it('starts verifying when a request comes before anything else asked', async () => {
    const v = held();
    const gate = createPacksGate(v.load);
    const answer = gate.after(() => undefined, () => 'ok');
    expect(v.starts()).toBe(1);
    v.finish();
    await expect(answer).resolves.toBe('ok');
  });

  it('authorizes a waiting request again, and refuses it when its window went meanwhile', async () => {
    const v = held();
    const gate = createPacksGate(v.load);
    let windowOpen = true;
    let ran = false;
    const answer = gate.after(
      () => {
        if (!windowOpen) throw new Error('Unauthorized sender');
      },
      () => {
        ran = true;
      }
    );
    windowOpen = false;
    v.finish();
    await expect(answer).rejects.toThrow('Unauthorized sender');
    expect(ran).toBe(false);
  });

  it('runs a request at once, synchronously, once the packs are verified', async () => {
    const v = held();
    const gate = createPacksGate(v.load);
    const verified = gate.verify();
    v.finish();
    await verified;
    let authorized = 0;
    // Not a promise: the request runs in the same turn, as it did before the gate existed.
    expect(
      gate.after(
        () => void (authorized += 1),
        () => 'now'
      )
    ).toBe('now');
    // The caller authorized it already; the gate only authorizes again after a wait.
    expect(authorized).toBe(0);
  });

  it('gives every waiting request the error that stopped verification, never runs one, and verifies again when asked again', async () => {
    let attempt = 0;
    let finish!: () => void;
    const gate = createPacksGate(() => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error('The packs folder could not be read.'));
      return new Promise<void>((resolve) => (finish = resolve));
    });
    let ran = 0;
    const requests = [gate.after(() => undefined, () => void (ran += 1)), gate.after(() => undefined, () => void (ran += 1))];
    for (const r of requests) await expect(r).rejects.toThrow('The packs folder could not be read.');
    expect(ran).toBe(0);
    expect(gate.verified).toBe(false);
    // The editor's Reload asks for the catalogue again: the packs are read afresh, and nothing runs until they are verified.
    const reload = gate.after(() => undefined, () => 'the catalogue');
    expect(attempt).toBe(2);
    await tick();
    expect(gate.verified).toBe(false);
    finish();
    await expect(reload).resolves.toBe('the catalogue');
    expect(gate.verified).toBe(true);
  });

  it('verifies again after a verification that threw before it could start', async () => {
    let attempt = 0;
    const gate = createPacksGate(() => {
      attempt += 1;
      if (attempt === 1) throw new Error('No packs folder.');
      return Promise.resolve();
    });
    await expect(gate.after(() => undefined, () => 'first')).rejects.toThrow('No packs folder.');
    await expect(gate.after(() => undefined, () => 'second')).resolves.toBe('second');
    expect(attempt).toBe(2);
  });
});
