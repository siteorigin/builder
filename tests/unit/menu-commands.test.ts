import { describe, expect, it } from 'vitest';
import { createMenuCommands, type MenuCommand } from '../../src/main/menu-commands';

type Win = { id: number };

/** A router over fake windows: `openWindow` records the request, and the test decides when one exists. A window
 *  whose renderer is `crashed` cannot take a command. */
function setup({ window = null as Win | null, opening = null as string | null } = {}) {
  const state = { window, opening, opens: 0, crashed: false };
  const sent: [number, MenuCommand][] = [];
  const router = createMenuCommands<Win>({
    window: () => state.window,
    openWindow: () => void state.opens++,
    opening: () => state.opening,
    send: (w, cmd) => !state.crashed && sent.push([w.id, cmd]) > 0
  });
  return { router, state, sent };
}

describe('File menu commands', () => {
  it('sends at once to a window whose editor is ready', () => {
    const w = { id: 1 };
    const { router, state, sent } = setup({ window: w });
    router.ready(w);
    router.run('new-project');
    expect(sent).toEqual([[1, 'new-project']]);
    expect(state.opens).toBe(0);
    expect(router.pending).toBeNull();
  });

  it('with no window, brings one up and sends once its editor is ready (#255)', () => {
    const { router, state, sent } = setup();
    router.run('open-project');
    expect(state.opens).toBe(1);
    expect(sent).toEqual([]);
    const w = { id: 2 };
    state.window = w;
    expect(sent).toEqual([]);
    router.ready(w);
    expect(sent).toEqual([[2, 'open-project']]);
    // A later ready message (the screen remounts) does not send it again.
    router.ready(w);
    expect(sent).toHaveLength(1);
  });

  it('keeps only the latest command chosen while the window is coming', () => {
    const { router, state, sent } = setup();
    router.run('new-project');
    // The window is still being created: the caller joins that creation instead of starting another.
    router.run('open-project');
    expect(router.pending).toBe('open-project');
    expect(state.opens).toBe(2);
    const w = { id: 3 };
    state.window = w;
    router.run('new-project');
    // A window exists now, so no other is asked for.
    expect(state.opens).toBe(2);
    router.ready(w);
    expect(sent).toEqual([[3, 'new-project']]);
  });

  it('waits while the editor reloads, and sends to the new page once it is ready', () => {
    const w = { id: 4 };
    const { router, sent } = setup({ window: w });
    router.ready(w);
    router.navigating(w);
    router.run('new-project');
    expect(sent).toEqual([]);
    // The outgoing page, still starting up, says it is ready before the new one commits: it would lose the command.
    router.ready(w);
    expect(sent).toEqual([]);
    router.navigated(w, true);
    expect(sent).toEqual([]);
    router.ready(w);
    expect(sent).toEqual([[4, 'new-project']]);
  });

  it('a navigation the editor refused leaves it ready, and a command chosen meanwhile is sent', () => {
    const w = { id: 15 };
    const { router, sent } = setup({ window: w });
    router.ready(w);
    router.navigating(w);
    router.run('open-project');
    expect(sent).toEqual([]);
    router.navigated(w, false);
    expect(sent).toEqual([[15, 'open-project']]);
    router.run('new-project');
    expect(sent).toEqual([
      [15, 'open-project'],
      [15, 'new-project']
    ]);
  });

  it('keeps a command the editor could not take (its renderer crashed unnoticed) until it is ready again', () => {
    const w = { id: 19 };
    const { router, state, sent } = setup({ window: w });
    router.ready(w);
    router.navigating(w);
    router.run('new-project');
    state.crashed = true;
    // The loading stops as the renderer goes, before its loss is reported.
    router.navigated(w, false);
    expect(sent).toEqual([]);
    expect(router.pending).toBe('new-project');
    // It is not sent again until the reloaded editor says it is ready.
    state.crashed = false;
    router.navigated(w, false);
    expect(sent).toEqual([]);
    router.navigated(w, true);
    router.ready(w);
    expect(sent).toEqual([[19, 'new-project']]);
  });

  it('waits after the editor crashed until it has loaded again', () => {
    const w = { id: 16 };
    const { router, sent } = setup({ window: w });
    router.ready(w);
    router.unready(w);
    router.run('new-project');
    expect(sent).toEqual([]);
    router.ready(w);
    expect(sent).toEqual([[16, 'new-project']]);
  });

  it('ignores readiness from a window that is not the current one', () => {
    const old = { id: 5 };
    const current = { id: 6 };
    const { router, state, sent } = setup({ window: current });
    router.ready(old);
    router.run('open-project');
    expect(sent).toEqual([]);
    router.ready(current);
    expect(sent).toEqual([[6, 'open-project']]);
    // The old window going away does not take the current one's readiness with it.
    router.unready(old);
    router.navigated(old, true);
    router.closed(old);
    router.run('new-project');
    expect(sent).toEqual([
      [6, 'open-project'],
      [6, 'new-project']
    ]);
    expect(state.opens).toBe(0);
  });

  it('drops a waiting command when its window closes before the editor is ready', () => {
    const { router, state, sent } = setup();
    router.run('new-project');
    const w = { id: 7 };
    state.window = w;
    state.window = null;
    router.closed(w);
    expect(router.pending).toBeNull();
    // A window brought up later (the Dock icon) opens without acting on it.
    const next = { id: 8 };
    state.window = next;
    router.ready(next);
    expect(sent).toEqual([]);
  });

  it('a closing window does not drop a command waiting for its replacement', () => {
    const old = { id: 9 };
    const next = { id: 10 };
    const { router, state, sent } = setup({ window: next });
    router.ready(old);
    router.run('new-project');
    router.closed(old);
    expect(router.pending).toBe('new-project');
    router.ready(next);
    expect(sent).toEqual([[10, 'new-project']]);
    expect(state.opens).toBe(0);
  });

  it('with no window and a project still open, Export and Close Project bring the editor back and act on it', () => {
    for (const cmd of ['export', 'close-project'] as const) {
      const { router, state, sent } = setup({ opening: '/sites/a#1' });
      router.run(cmd);
      expect(state.opens).toBe(1);
      const w = { id: 11 };
      state.window = w;
      router.ready(w);
      expect(sent).toEqual([[11, cmd]]);
    }
  });

  it('drops a waiting command when no window could be brought up', () => {
    const { router, state, sent } = setup();
    router.run('new-project');
    router.windowFailed();
    expect(router.pending).toBeNull();
    const w = { id: 17 };
    state.window = w;
    router.ready(w);
    expect(sent).toEqual([]);
  });

  it('keeps a waiting command when the window exists but failed to load first time', () => {
    const w = { id: 18 };
    const { router, sent } = setup({ window: w });
    router.run('open-project');
    router.windowFailed();
    expect(router.pending).toBe('open-project');
    router.ready(w);
    expect(sent).toEqual([[18, 'open-project']]);
  });

  it('drops Export and Close Project when the project they were chosen for closes or another opens first', () => {
    for (const cmd of ['export', 'close-project'] as const)
      for (const next of [null, '/sites/b#2', '/sites/a#2']) {
        const { router, state, sent } = setup({ opening: '/sites/a#1' });
        router.run(cmd);
        expect(router.pending).toBe(cmd);
        state.opening = next;
        const w = { id: 12 };
        state.window = w;
        router.ready(w);
        expect(sent).toEqual([]);
        expect(router.pending).toBeNull();
      }
  });

  it('does nothing for Export or Close Project with no project open', () => {
    const w = { id: 13 };
    const { router, state, sent } = setup({ window: w });
    router.ready(w);
    router.run('export');
    router.run('close-project');
    expect(sent).toEqual([]);
    // Nor do they bring up a window when there is none.
    state.window = null;
    router.run('export');
    router.run('close-project');
    expect(state.opens).toBe(0);
    expect(router.pending).toBeNull();
  });

  it('New and Open do not depend on the open project', () => {
    for (const cmd of ['new-project', 'open-project'] as const) {
      const { router, state, sent } = setup({ opening: '/sites/a#1' });
      router.run(cmd);
      expect(router.pending).toBe(cmd);
      state.opening = null;
      const w = { id: 14 };
      state.window = w;
      router.ready(w);
      expect(sent).toEqual([[14, cmd]]);
    }
  });
});
