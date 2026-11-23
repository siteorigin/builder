import { describe, expect, it } from 'vitest';
import { createMenuCommands, type MenuCommand } from '../../src/main/menu-commands';

type Win = { id: number };

/**
 * A router over fake windows: `openWindow` records the request, and the test decides when one exists. Each send
 * is recorded; a window in `live` confirms what it is sent at once, as a loaded editor does, and any other (one
 * whose page is gone or not listening yet) never does.
 */
function setup({ window = null as Win | null, opening = null as string | null } = {}) {
  const state = { window, opening, opens: 0, live: new Set<number>() };
  const sent: [number, MenuCommand][] = [];
  const router = createMenuCommands<Win>({
    window: () => state.window,
    openWindow: () => void state.opens++,
    opening: () => state.opening,
    send: (w, { cmd, id }) => {
      sent.push([w.id, cmd]);
      if (state.live.has(w.id)) router.received(id);
    }
  });
  /** The window's editor has loaded and says it is ready. */
  const ready = (w: Win) => {
    state.live.add(w.id);
    router.ready(w);
  };
  /** The window's page went away without saying so (it crashed, or a new page replaced it). */
  const gone = (w: Win) => state.live.delete(w.id);
  return { router, state, sent, ready, gone };
}

describe('File menu commands', () => {
  it('sends at once to a window whose editor is ready', () => {
    const w = { id: 1 };
    const { router, state, sent, ready } = setup({ window: w });
    ready(w);
    router.run('new-project');
    expect(sent).toEqual([[1, 'new-project']]);
    expect(state.opens).toBe(0);
    expect(router.pending).toBeNull();
  });

  it('with no window, brings one up and sends once its editor is ready (#255)', () => {
    const { router, state, sent, ready } = setup();
    router.run('open-project');
    expect(state.opens).toBe(1);
    expect(sent).toEqual([]);
    const w = { id: 2 };
    state.window = w;
    expect(sent).toEqual([]);
    ready(w);
    expect(sent).toEqual([[2, 'open-project']]);
    // Received, so a later ready message (the screen remounts) does not send it again.
    ready(w);
    expect(sent).toHaveLength(1);
  });

  it('keeps only the latest command chosen while the window is coming', () => {
    const { router, state, sent, ready } = setup();
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
    ready(w);
    expect(sent).toEqual([[3, 'new-project']]);
  });

  it('offers a command again until the editor receives it: a page that crashed or was replaced gets it on reload', () => {
    const w = { id: 4 };
    const { router, sent, ready, gone } = setup({ window: w });
    ready(w);
    // The page goes before the main process hears of it, and the command is sent to it.
    gone(w);
    router.run('new-project');
    expect(sent).toEqual([[4, 'new-project']]);
    expect(router.pending).toBe('new-project');
    // The reloaded page says it is ready, and receives it.
    ready(w);
    expect(sent).toEqual([
      [4, 'new-project'],
      [4, 'new-project']
    ]);
    expect(router.pending).toBeNull();
  });

  it('a new page replacing the editor must say it is ready before it is sent anything', () => {
    const w = { id: 5 };
    const { router, sent, ready, gone } = setup({ window: w });
    ready(w);
    gone(w);
    router.unready(w);
    router.run('open-project');
    expect(sent).toEqual([]);
    ready(w);
    expect(sent).toEqual([[5, 'open-project']]);
    expect(router.pending).toBeNull();
  });

  it('a navigation the editor refused leaves it ready', () => {
    const w = { id: 6 };
    const { router, sent, ready } = setup({ window: w });
    ready(w);
    // Nothing committed, so nothing told the router the page changed.
    router.run('open-project');
    expect(sent).toEqual([[6, 'open-project']]);
    expect(router.pending).toBeNull();
  });

  it('ignores readiness from a window that is not the current one', () => {
    const old = { id: 7 };
    const current = { id: 8 };
    const { router, state, sent, ready } = setup({ window: current });
    ready(old);
    router.run('open-project');
    expect(sent).toEqual([]);
    ready(current);
    expect(sent).toEqual([[8, 'open-project']]);
    // The old window going away does not take the current one's readiness with it.
    router.unready(old);
    router.closed(old);
    router.run('new-project');
    expect(sent).toEqual([
      [8, 'open-project'],
      [8, 'new-project']
    ]);
    expect(state.opens).toBe(0);
  });

  it('a confirmation for an earlier command does not clear a later one', () => {
    const w = { id: 9 };
    const { router, sent, ready, gone } = setup({ window: w });
    ready(w);
    gone(w);
    router.run('new-project');
    router.run('open-project');
    // The first command's id is one less than the second's.
    router.received(1);
    expect(router.pending).toBe('open-project');
    ready(w);
    expect(sent.at(-1)).toEqual([9, 'open-project']);
    expect(router.pending).toBeNull();
  });

  it('drops a waiting command when its window closes before the editor is ready', () => {
    const { router, state, sent, ready } = setup();
    router.run('new-project');
    const w = { id: 10 };
    state.window = w;
    state.window = null;
    router.closed(w);
    expect(router.pending).toBeNull();
    // A window brought up later (the Dock icon) opens without acting on it.
    const next = { id: 11 };
    state.window = next;
    ready(next);
    expect(sent).toEqual([]);
  });

  it('a closing window does not drop a command waiting for its replacement', () => {
    const old = { id: 12 };
    const next = { id: 13 };
    const { router, state, sent, ready } = setup({ window: next });
    ready(old);
    router.run('new-project');
    router.closed(old);
    expect(router.pending).toBe('new-project');
    ready(next);
    expect(sent).toEqual([[13, 'new-project']]);
    expect(state.opens).toBe(0);
  });

  it('drops a waiting command when no window could be brought up', () => {
    const { router, state, sent, ready } = setup();
    router.run('new-project');
    router.windowFailed();
    expect(router.pending).toBeNull();
    const w = { id: 14 };
    state.window = w;
    ready(w);
    expect(sent).toEqual([]);
  });

  it('keeps a waiting command when the window exists but failed to load first time', () => {
    const w = { id: 15 };
    const { router, sent, ready } = setup({ window: w });
    router.run('open-project');
    router.windowFailed();
    expect(router.pending).toBe('open-project');
    ready(w);
    expect(sent).toEqual([[15, 'open-project']]);
  });

  it('with no window and a project still open, Export and Close Project bring the editor back and act on it', () => {
    for (const cmd of ['export', 'close-project'] as const) {
      const { router, state, sent, ready } = setup({ opening: '/sites/a#1' });
      router.run(cmd);
      expect(state.opens).toBe(1);
      const w = { id: 16 };
      state.window = w;
      ready(w);
      expect(sent).toEqual([[16, cmd]]);
    }
  });

  it('drops Export and Close Project when the project they were chosen for closes or another opens first', () => {
    for (const cmd of ['export', 'close-project'] as const)
      for (const next of [null, '/sites/b#2', '/sites/a#2']) {
        const { router, state, sent, ready } = setup({ opening: '/sites/a#1' });
        router.run(cmd);
        expect(router.pending).toBe(cmd);
        state.opening = next;
        const w = { id: 17 };
        state.window = w;
        ready(w);
        expect(sent).toEqual([]);
        expect(router.pending).toBeNull();
      }
  });

  it('does not offer Export or Close Project again once the project they were chosen for has gone', () => {
    const w = { id: 18 };
    const { router, state, sent, ready, gone } = setup({ window: w, opening: '/sites/a#1' });
    ready(w);
    gone(w);
    router.run('close-project');
    expect(sent).toEqual([[18, 'close-project']]);
    state.opening = null;
    ready(w);
    expect(sent).toHaveLength(1);
    expect(router.pending).toBeNull();
  });

  it('does nothing for Export or Close Project with no project open', () => {
    const w = { id: 19 };
    const { router, state, sent, ready } = setup({ window: w });
    ready(w);
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
    for (const cmd of ['new-project', 'open-project'] as const)
      for (const next of [null, '/sites/b#2']) {
        const { router, state, sent, ready } = setup({ opening: '/sites/a#1' });
        router.run(cmd);
        expect(router.pending).toBe(cmd);
        state.opening = next;
        const w = { id: 20 };
        state.window = w;
        ready(w);
        expect(sent).toEqual([[20, cmd]]);
      }
  });
});
