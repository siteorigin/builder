import { describe, expect, it } from 'vitest';
import { createPageGate, failedWithRevision, gatedPick, PAGE_CATCH_UP_MS, type GateClock } from '../../src/renderer/src/lib/page-gate';

/** A clock the test moves by hand, with timers that fire as it passes them. */
function fakeClock() {
  let now = 1000;
  let next = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: GateClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (id) => void timers.delete(id as number)
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
  };
  return { clock, advance, pending: () => timers.size };
}

/** An editor at `revision`, with a page that loaded showing it. */
function setup(revision = 3) {
  const editor = { revision };
  const time = fakeClock();
  const gate = createPageGate(() => editor.revision, time.clock);
  gate.shown(revision);
  /** A change is applied: the editor takes the next revision. */
  const apply = () => gate.took(++editor.revision);
  const picks: string[] = [];
  return { editor, gate, apply, picks, ...time };
}

describe('the page gate while a save publishes (#755)', () => {
  it('is open while the page shows what the editor has', () => {
    const { gate } = setup();
    expect(gate.behind()).toBe(false);
  });

  it('holds picks from the moment a change is applied until the page acknowledges its revision', () => {
    const { gate, apply, editor, picks } = setup();
    apply();
    expect(gate.behind()).toBe(true);
    gate.hold(() => picks.push('heading'));
    expect(picks).toEqual([]);
    gate.shown(editor.revision);
    expect(gate.behind()).toBe(false);
    expect(picks).toEqual(['heading']);
  });

  it('keeps waiting for an acknowledgement of an earlier revision than the editor has', () => {
    const { gate, apply, editor, picks } = setup();
    apply();
    apply();
    gate.hold(() => picks.push('heading'));
    gate.shown(editor.revision - 1);
    expect(gate.behind()).toBe(true);
    expect(picks).toEqual([]);
    gate.shown(editor.revision);
    expect(picks).toEqual(['heading']);
  });

  it('takes only the latest pick held, once', () => {
    const { gate, apply, editor, picks } = setup();
    apply();
    gate.hold(() => picks.push('first'));
    gate.hold(() => picks.push('second'));
    gate.shown(editor.revision);
    gate.shown(editor.revision);
    expect(picks).toEqual(['second']);
  });

  it('opens as soon as the page reports that the update failed', () => {
    const { gate, apply, picks, advance } = setup();
    apply();
    gate.hold(() => picks.push('heading'));
    advance(50);
    gate.failed();
    expect(gate.behind()).toBe(false);
    expect(picks).toEqual(['heading']);
  });

  it('shuts again for the next change after a failure', () => {
    const { gate, apply } = setup();
    apply();
    gate.failed();
    apply();
    expect(gate.behind()).toBe(true);
  });

  it('ignores a failure reported while it is open', () => {
    const { gate, apply } = setup();
    gate.failed();
    apply();
    expect(gate.behind()).toBe(true);
  });

  it('opens on its own when no acknowledgement or failure ever arrives', () => {
    const { gate, apply, picks, advance, pending } = setup();
    apply();
    gate.hold(() => picks.push('heading'));
    advance(PAGE_CATCH_UP_MS - 1);
    expect(gate.behind()).toBe(true);
    expect(picks).toEqual([]);
    advance(2);
    expect(gate.behind()).toBe(false);
    expect(picks).toEqual(['heading']);
    expect(pending()).toBe(0);
  });

  it('counts the fallback from the latest change applied', () => {
    const { gate, apply, picks, advance } = setup();
    apply();
    gate.hold(() => picks.push('heading'));
    advance(PAGE_CATCH_UP_MS - 100);
    apply();
    advance(200);
    expect(gate.behind()).toBe(true);
    expect(picks).toEqual([]);
    advance(PAGE_CATCH_UP_MS);
    expect(picks).toEqual(['heading']);
  });

  it('forgets a held pick when the page it was made on goes away', () => {
    const { gate, apply, editor, picks, pending } = setup();
    apply();
    gate.hold(() => picks.push('heading'));
    gate.drop();
    expect(pending()).toBe(0);
    gate.shown(editor.revision);
    expect(picks).toEqual([]);
  });

  it('takes a pick at once when it is open', () => {
    const { gate, picks } = setup();
    gate.hold(() => picks.push('heading'));
    expect(picks).toEqual(['heading']);
  });
});

describe('which page messages the gate holds (#755)', () => {
  it('holds a click, and drops a double-click or context menu, while editing', () => {
    expect(gatedPick('select', 'edit')).toBe('hold');
    expect(gatedPick('dblclick', 'edit')).toBe('drop');
    expect(gatedPick('contextmenu', 'edit')).toBe('drop');
  });

  it('lets an inline text commit already in flight through, with everything else the page says', () => {
    for (const type of ['textCommit', 'textCancel', 'textFocus', 'revisionApplied', 'runtimeError', 'navigated', 'ready', 'hover', 'link', 'measured']) expect(gatedPick(type, 'edit')).toBeNull();
  });

  it('gates nothing in Preview', () => {
    for (const type of ['select', 'dblclick', 'contextmenu', 'link']) expect(gatedPick(type, 'preview')).toBeNull();
  });
});

describe('a failed save and the gate (#755)', () => {
  const failure = JSON.stringify({ label: 'Hero lead', message: 'EACCES: permission denied' });
  it('opens it for a failure that arrives with the revision it was taken at', () => {
    expect(failedWithRevision({ revision: 4, failure: null }, { revision: 5, failure })).toBe(true);
  });

  it('keeps it shut for a failure before the revision moved, while the one before is still publishing', () => {
    expect(failedWithRevision({ revision: 5, failure: null }, { revision: 5, failure })).toBe(false);
  });

  it('keeps it shut for a later revision while an earlier failure is still shown', () => {
    expect(failedWithRevision({ revision: 5, failure }, { revision: 6, failure })).toBe(false);
    expect(failedWithRevision({ revision: 5, failure: null }, { revision: 6, failure: null })).toBe(false);
  });
});

describe('the page gate for a host’s project in a live session (#766)', () => {
  it('has no fallback: a page behind waits for the page to show the revision, however long, with no timer running', () => {
    const editor = { revision: 3 };
    const time = fakeClock();
    let remote = true;
    const gate = createPageGate(() => editor.revision, time.clock, () => (remote ? Infinity : PAGE_CATCH_UP_MS));
    gate.shown(3);
    gate.took(++editor.revision);
    const picks: string[] = [];
    gate.hold(() => picks.push('heading'));
    time.advance(PAGE_CATCH_UP_MS * 10);
    expect(gate.behind()).toBe(true);
    expect(picks).toEqual([]);
    expect(time.pending()).toBe(0);
    // The reloaded page shows the revision: the held pick is taken.
    gate.shown(4);
    expect(picks).toEqual(['heading']);
    // Back on this computer's own project, the fallback holds again.
    remote = false;
    gate.took(++editor.revision);
    time.advance(PAGE_CATCH_UP_MS + 1);
    expect(gate.behind()).toBe(false);
  });
});
