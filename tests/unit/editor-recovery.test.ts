/**
 * A crashed editor asks to be loaded again (#886): once per crash, a turn after the crash's own cleanup, only while its
 * window is meant to stay, and never acting on an answer that arrives after the editor came back another way.
 */
import { describe, expect, it } from 'vitest';
import { createEditorRecovery, crashQuestion, type RecoveryChoice } from '../../src/main/editor-recovery';

function rig() {
  const turns: (() => void)[] = [];
  const asked: { signal: AbortSignal; answer: (c: RecoveryChoice) => void }[] = [];
  const done: string[] = [];
  const state = { stays: true };
  const recovery = createEditorRecovery({
    mayOffer: () => state.stays,
    ask: (signal) => new Promise<RecoveryChoice>((answer) => asked.push({ signal, answer })),
    reload: () => done.push('reload'),
    close: () => done.push('close'),
    defer: (fn) => turns.push(fn)
  });
  const nextTurn = () => turns.splice(0).forEach((fn) => fn());
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return { recovery, asked, done, state, nextTurn, settle };
}

describe('editor recovery (#886)', () => {
  it('asks a turn after a crash, and reloads the editor when Reload Editor is chosen', async () => {
    const { recovery, asked, done, nextTurn, settle } = rig();
    recovery.gone();
    expect(asked).toHaveLength(0);
    nextTurn();
    expect(asked).toHaveLength(1);
    asked[0].answer('reload');
    await settle();
    expect(done).toEqual(['reload']);
  });

  it('closes the window when Close Window is chosen', async () => {
    const { recovery, asked, done, nextTurn, settle } = rig();
    recovery.gone();
    nextTurn();
    asked[0].answer('close');
    await settle();
    expect(done).toEqual(['close']);
    // Nothing is left to recover.
    expect(recovery.recover()).toBe(false);
    expect(done).toEqual(['close']);
  });

  it('asks nothing when the window is closing or the app quitting by the time the crash is cleaned up', async () => {
    const { recovery, asked, state, nextTurn } = rig();
    recovery.gone();
    // The crash settled a close the person had asked for: the window is going.
    state.stays = false;
    nextTurn();
    expect(asked).toHaveLength(0);
  });

  it('ignores an answer given once the window has started closing', async () => {
    const { recovery, asked, done, state, nextTurn, settle } = rig();
    recovery.gone();
    nextTurn();
    state.stays = false;
    asked[0].answer('reload');
    await settle();
    expect(done).toEqual([]);
  });

  it('withdraws the question when a File command loads the editor again, and ignores its late answer', async () => {
    const { recovery, asked, done, nextTurn, settle } = rig();
    recovery.gone();
    nextTurn();
    expect(recovery.recover()).toBe(true);
    expect(done).toEqual(['reload']);
    expect(asked[0].signal.aborted).toBe(true);
    asked[0].answer('close');
    await settle();
    expect(done).toEqual(['reload']);
    // Loaded once: a second command while the page is coming back does not load it again.
    expect(recovery.recover()).toBe(false);
    expect(done).toEqual(['reload']);
  });

  it('asks nothing for a crash that a File command already recovered before the question was due', () => {
    const { recovery, asked, done, nextTurn } = rig();
    recovery.gone();
    recovery.recover();
    nextTurn();
    expect(asked).toHaveLength(0);
    expect(done).toEqual(['reload']);
  });

  it('does nothing for a crash once a new page has replaced the editor, or the window has gone', async () => {
    const { recovery, asked, done, nextTurn, settle } = rig();
    recovery.gone();
    nextTurn();
    recovery.settle();
    expect(asked[0].signal.aborted).toBe(true);
    asked[0].answer('reload');
    await settle();
    expect(done).toEqual([]);
    expect(recovery.recover()).toBe(false);
  });

  it('asks again for a second crash, and only the newest question counts', async () => {
    const { recovery, asked, done, nextTurn, settle } = rig();
    recovery.gone();
    nextTurn();
    asked[0].answer('reload');
    await settle();
    recovery.settle(); // the reloaded editor committed
    recovery.gone();
    nextTurn();
    expect(asked).toHaveLength(2);
    // Two crashes before the first question was answered: the first is withdrawn.
    recovery.gone();
    expect(asked[1].signal.aborted).toBe(true);
    asked[1].answer('close');
    nextTurn();
    await settle();
    expect(asked).toHaveLength(3);
    asked[2].answer('reload');
    await settle();
    expect(done).toEqual(['reload', 'reload']);
  });

  it('words the question for an open project or for Welcome, with Reload Editor as default and Esc', () => {
    const open = crashQuestion(true);
    expect(open.message).toBe('The editor stopped unexpectedly');
    expect(open.detail).toContain('return to your project');
    expect(open.buttons).toEqual(['Reload Editor', 'Close Window']);
    expect(open.buttons[open.defaultId]).toBe('Reload Editor');
    expect(open.buttons[open.cancelId]).toBe('Reload Editor');
    expect(crashQuestion(false).detail).toBe('Reload the editor to return to SiteOrigin Builder.');
  });
});
