/**
 * Delivers the File menu's commands (New Project, Open Project, Export, Close Project) to the editor. The editor
 * acts on a command only once it has loaded and shows the right screen, so a command chosen while there is no
 * window (macOS keeps the app running after the last one closes), or while the window's editor is still
 * starting or reloading, waits: a window is brought up and the command is sent when its editor says it is
 * ready. Only the latest command waits; choosing another replaces it. Export and Close Project act on the
 * project that was open when they were chosen, and are dropped if it closes or another opens first.
 *
 * The editor confirms each command as it receives it. Until then the command is offered again whenever the editor
 * says it is ready, so one sent to a page that crashed or was replaced before it arrived reaches the next one; the
 * editor ignores a command it has already acted on.
 *
 * No electron import: the caller passes how to reach the window, so the router is tested on its own.
 */

export type MenuCommand = 'new-project' | 'open-project' | 'export' | 'close-project';

export interface MenuCommandOptions<W> {
  /** The editor window, or null when there is none. */
  window: () => W | null;
  /** Bring up a window. Called only while there is none; the caller joins a creation already under way. */
  openWindow: () => void;
  /** Names the current opening of the open project, or null while none is open or it is closing. */
  opening: () => string | null;
  /** Hand the command to the window's editor, which confirms it with `received(id)`. */
  send: (w: W, command: { cmd: MenuCommand; id: number }) => void;
}

/** The commands that act on the open project rather than start or choose one. */
const PROJECT_COMMANDS: ReadonlySet<MenuCommand> = new Set(['export', 'close-project']);

export function createMenuCommands<W>(opts: MenuCommandOptions<W>) {
  let pending: { cmd: MenuCommand; opening: string | null; id: number } | null = null;
  /** The window whose editor last said it is ready, until a new page replaces it, it crashes or it goes. */
  let ready: W | null = null;
  let ids = 0;

  const flush = () => {
    if (!pending) return;
    if (pending.opening !== null && opts.opening() !== pending.opening) {
      pending = null;
      return;
    }
    const w = opts.window();
    if (w && w === ready) opts.send(w, { cmd: pending.cmd, id: pending.id });
  };

  return {
    /** The author chose a File menu command. */
    run(cmd: MenuCommand) {
      const project = PROJECT_COMMANDS.has(cmd);
      const opening = project ? opts.opening() : null;
      // No project to export or close (the menu offers neither then, but it may have just closed).
      if (project && opening === null) return;
      pending = { cmd, opening, id: ++ids };
      if (!opts.window()) opts.openWindow();
      flush();
    },
    /** The window's editor has loaded, shows its screen and listens for commands. */
    ready(w: W) {
      ready = w;
      flush();
    },
    /** The editor received command `id`: it is not offered again. */
    received(id: number) {
      if (pending?.id === id) pending = null;
    },
    /** A new page replaced the window's editor, or it crashed: commands wait until it says it is ready again. */
    unready(w: W) {
      if (ready === w) ready = null;
    },
    /** The window closed. A command still waiting is dropped with it: it was meant for the window that went. */
    closed(w: W) {
      if (ready === w) ready = null;
      if (!opts.window()) pending = null;
    },
    /** No window could be brought up: the waiting command is dropped, so a window opened later does not act on it. */
    windowFailed() {
      if (!opts.window()) pending = null;
    },
    /** The command waiting for an editor to receive it, if any. */
    get pending(): MenuCommand | null {
      return pending?.cmd ?? null;
    }
  };
}
