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
  /** Hand the command to the window's editor. False when it cannot take it (its renderer crashed): the command then
   *  waits until the editor has loaded again and says it is ready. */
  send: (w: W, cmd: MenuCommand) => boolean;
}

/** The commands that act on the open project rather than start or choose one. */
const PROJECT_COMMANDS: ReadonlySet<MenuCommand> = new Set(['export', 'close-project']);

export function createMenuCommands<W>(opts: MenuCommandOptions<W>) {
  let pending: { cmd: MenuCommand; opening: string | null } | null = null;
  /** The window whose editor last said it is ready, until a new page replaces it or it goes. */
  let ready: W | null = null;
  /** The window whose page is being navigated: until the new page commits (or the navigation is called off),
   *  the outgoing editor may still say it is ready, and a command sent to it would be lost with it. */
  let navigating: W | null = null;

  const flush = () => {
    if (!pending) return;
    if (pending.opening !== null && opts.opening() !== pending.opening) {
      pending = null;
      return;
    }
    const w = opts.window();
    if (!w || w !== ready || w === navigating) return;
    const sending = pending;
    // Cleared before sending, so a second ready message cannot send it again.
    pending = null;
    if (opts.send(w, sending.cmd)) return;
    ready = null;
    pending = sending;
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
    /** A new page starts to load in the window (a reload): commands wait until it commits or is called off. */
    navigating(w: W) {
      navigating = w;
    },
    /** The window's navigation ended. A new page that `replaced` the editor must say it is ready itself; one that
     *  was called off (a link or dropped file the editor refused) leaves the editor as it was, still ready. */
    navigated(w: W, replaced: boolean) {
      if (navigating === w) navigating = null;
      if (replaced && ready === w) ready = null;
      flush();
    },
    /** The window's editor crashed: commands wait until it has loaded again and is ready. */
    unready(w: W) {
      if (ready === w) ready = null;
    },
    /** The window closed. A command still waiting is dropped with it: it was meant for the window that went. */
    closed(w: W) {
      if (ready === w) ready = null;
      if (navigating === w) navigating = null;
      if (!opts.window()) pending = null;
    },
    /** No window could be brought up: the waiting command is dropped, so a window opened later does not act on it. */
    windowFailed() {
      if (!opts.window()) pending = null;
    },
    /** The command waiting for an editor, if any. */
    get pending(): MenuCommand | null {
      return pending?.cmd ?? null;
    }
  };
}
