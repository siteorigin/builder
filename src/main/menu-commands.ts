/**
 * Delivers the File menu's commands (New Project, Open Project, Export, Close Project) to the editor. The editor
 * acts on a command only once it has loaded and shows the right screen, so a command chosen while there is no
 * window (macOS keeps the app running after the last one closes), or while the window's editor is still
 * starting or reloading, waits: a window is brought up and the command is sent when its editor says it is
 * ready. Only the latest command waits; choosing another replaces it. Export and Close Project act on the
 * project that was open when they were chosen, and are dropped if it closes or another opens first.
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
  /** Hand the command to the window's editor. */
  send: (w: W, cmd: MenuCommand) => void;
}

/** The commands that act on the open project rather than start or choose one. */
const PROJECT_COMMANDS: ReadonlySet<MenuCommand> = new Set(['export', 'close-project']);

export function createMenuCommands<W>(opts: MenuCommandOptions<W>) {
  let pending: { cmd: MenuCommand; opening: string | null } | null = null;
  /** The window whose editor last said it is ready, until it reloads or goes. */
  let ready: W | null = null;

  const flush = () => {
    if (!pending) return;
    if (pending.opening !== null && opts.opening() !== pending.opening) {
      pending = null;
      return;
    }
    const w = opts.window();
    if (!w || w !== ready) return;
    const { cmd } = pending;
    // Cleared before sending, so a second ready message cannot send it again.
    pending = null;
    opts.send(w, cmd);
  };

  return {
    /** The author chose a File menu command. */
    run(cmd: MenuCommand) {
      const project = PROJECT_COMMANDS.has(cmd);
      const opening = project ? opts.opening() : null;
      // No project to export or close (the menu offers neither then, but it may have just closed).
      if (project && opening === null) return;
      pending = { cmd, opening };
      if (!opts.window()) opts.openWindow();
      flush();
    },
    /** The window's editor has loaded, shows its screen and listens for commands. */
    ready(w: W) {
      ready = w;
      flush();
    },
    /** The window's editor is going away (it reloads or crashed): commands wait for it to be ready again. */
    unready(w: W) {
      if (ready === w) ready = null;
    },
    /** The window closed. A command still waiting is dropped with it: it was meant for the window that went. */
    closed(w: W) {
      if (ready === w) ready = null;
      if (!opts.window()) pending = null;
    },
    /** The command waiting for an editor, if any. */
    get pending(): MenuCommand | null {
      return pending?.cmd ?? null;
    }
  };
}
