/**
 * Native choosers and desktop hand-offs in automated runs (#494). An automated app never shows a native dialog, never
 * opens a link in the browser and never opens Finder: every open, save and message dialog is answered from a batch of
 * answers a test set beforehand, and every hand-off to the desktop (a link, a file to reveal or open) is recorded as
 * what the app asked for instead of done.
 *
 * Answers are used in order, one per chooser. A chooser takes the answer at the head of the batch only when it is
 * meant for it (the same dialog, and the title, message and selection it names, when it names them); otherwise, or
 * with no answer left, the chooser is closed as a person closing it would be (cancelled, or a message box's cancel
 * button) and recorded as mismatched or unanswered, so a test that forgot an answer gets a bounded, explained outcome
 * and never a dialog on screen. An answer a real chooser could not give (a file where it takes folders, a path that
 * does not exist, two files where it takes one, a type its filters leave out, a button it does not have) is used up
 * and refused, closing the chooser the same way. A save answer naming a file that already exists meets the system's
 * own Replace? question, which it answers itself (`overwrite`); unanswered, replacing is declined.
 *
 * A batch belongs to the editor window that was open when it was set (or, set while there was none, to the next one):
 * when that window closes or a new page replaces its editor, whatever is left of it expires, so a later window never
 * gets an answer meant for one that went.
 *
 * Installed only in automated runs, and reachable only from the main process itself (a test's app.evaluate, through
 * the debugger Playwright starts the app with), under DESKTOP_FIXTURES on globalThis. No IPC channel, preload API or
 * port is added: a normal launch has nothing new to reach, and keeps Electron's own dialog and shell.
 *
 * No electron import: the caller passes Electron's dialog and shell, so this is tested with stand-ins.
 */
import { statSync } from 'node:fs';
import { dirname, extname, isAbsolute } from 'node:path';

/** Where the installed fixtures are found on the main process's globalThis. */
export const DESKTOP_FIXTURES = Symbol.for('siteorigin.desktopFixtures');

/**
 * Whether this launch is driven by a test: Playwright's Electron loader defines __playwright_run before the main module
 * loads, and SITEORIGIN_HEADLESS=1 says so for other drivers. Such a launch is headless unless SITEORIGIN_HEADED=1
 * shows its window for a person debugging the script; its choosers are answered by the test either way.
 */
export function launchMode(env: Record<string, string | undefined>, global: object): { automated: boolean; headless: boolean } {
  const automated = env.SITEORIGIN_HEADLESS === '1' || typeof (global as { __playwright_run?: unknown }).__playwright_run === 'function';
  return { automated, headless: automated && env.SITEORIGIN_HEADED !== '1' };
}

export type DialogKind = 'open' | 'save' | 'message';

/** What an open chooser takes: one file, several files, one folder, or a file or a folder (macOS's Open Project). */
export type Selection = 'file' | 'files' | 'folder' | 'fileOrFolder';

/**
 * An answer for one chooser: which chooser it is for, then exactly one of what a person did there. `title` and
 * `message` must equal the chooser's own when given; `selection` must be what an open chooser takes.
 */
export interface Answer {
  dialog: DialogKind;
  title?: string;
  message?: string;
  selection?: Selection;
  /** Close the chooser without choosing. */
  cancel?: true;
  /** open: the files or folders chosen, absolute. */
  paths?: string[];
  /** save: the file named, absolute. */
  path?: string;
  /** save over a file that exists: the system's Replace? question, answered. Default: decline. */
  overwrite?: 'replace' | 'decline';
  /** message: the label of the button pressed. */
  button?: string;
  /** message: whether its checkbox ends up ticked. Default: as the app showed it. */
  checkbox?: boolean;
}

export interface QueuedAnswer extends Answer {
  id: string;
  /** Who set it (a driver request id), for the record. */
  request: string | null;
  /** The editor window it belongs to, or null until one opens. */
  window: number | null;
}

export interface FileFilter {
  name: string;
  extensions: string[];
}

/**
 * chosen: the answer was taken and its choice returned. cancelled: closed without a choice, as the answer said (or as
 * the system's Replace? question was declined). unanswered: no answer was left. mismatched: the next answer is for
 * another chooser, and stays for it. refused: the answer could not be given here, and is used up. closed: an error box,
 * which needs no answer.
 */
export type ChooserOutcome = 'chosen' | 'cancelled' | 'unanswered' | 'mismatched' | 'refused' | 'closed';

export interface ChooserEvent {
  type: 'chooser';
  seq: number;
  at: string;
  dialog: DialogKind | 'error';
  /** A synchronous dialog (showOpenDialogSync and the like). */
  sync: boolean;
  /** The id of the window it was shown over, or null for none. */
  window: number | null;
  title: string | null;
  message: string | null;
  detail: string | null;
  buttonLabel: string | null;
  defaultPath: string | null;
  /** open: what it takes. */
  selection?: Selection;
  filters?: FileFilter[];
  /** message: its buttons, and the one Esc presses. */
  buttons?: string[];
  cancelId?: number;
  outcome: ChooserOutcome;
  /** The answer it took (or, mismatched, the one left for another chooser), or null. */
  answer: string | null;
  /** Who set that answer. */
  request: string | null;
  /** What the app got back. */
  result: { paths: string[] } | { path: string | null } | { button: number; label: string | null; checkbox: boolean } | null;
  /** Why it was refused, mismatched or unanswered, or which Replace? question was declined. */
  reason?: string;
}

export interface IntentEvent {
  type: 'intent';
  seq: number;
  at: string;
  kind: 'open-external' | 'reveal' | 'open-path';
  /** The address (open-external) or path (reveal, open-path) the app handed over. */
  target: string;
}

export interface MenuEvent {
  type: 'menu';
  seq: number;
  at: string;
  /** The item's labels, from the menu bar down. */
  path: string[];
  /** The editor window the item was chosen for, or null when there was none. */
  window: number | null;
  request: string | null;
}

export interface AnswersEvent {
  type: 'answers';
  seq: number;
  at: string;
  /** set: a batch replaced what was left; expired: its window went. */
  change: 'set' | 'expired';
  /** The answers set, or the ones that expired. */
  answers: string[];
  /** set: the answers it replaced, unused. */
  replaced?: string[];
  window: number | null;
  request: string | null;
}

export type DesktopEvent = ChooserEvent | IntentEvent | MenuEvent | AnswersEvent;

export interface DesktopEvents {
  entries: DesktopEvent[];
  /** The cursor to read on from. */
  next: number;
  /** Events no longer kept: this many of the oldest. */
  dropped: number;
  /** Answers still waiting for their chooser, in order. */
  pending: QueuedAnswer[];
}

export interface DesktopFixtures {
  /** Replace the batch of answers ([] clears it); returns their ids. Throws, changing nothing, on a malformed one. */
  setAnswers(answers: unknown[], opts?: { request?: string | null }): string[];
  /** Events after `after` (a sequence number; default 0), at most `limit` of them, and the answers still waiting. */
  events(after?: number, limit?: number): DesktopEvents;
  /** Record a menu item chosen for the test, in order with everything else. */
  noteMenu(path: string[], window: number | null, request?: string | null): number;
  /** The last sequence number given out. */
  readonly seq: number;
}

/** The parts of Electron's dialog module replaced. */
export interface DialogLike {
  showOpenDialog: (...args: any[]) => Promise<{ canceled: boolean; filePaths: string[] }>;
  showOpenDialogSync: (...args: any[]) => string[] | undefined;
  showSaveDialog: (...args: any[]) => Promise<{ canceled: boolean; filePath: string }>;
  showSaveDialogSync: (...args: any[]) => string;
  showMessageBox: (...args: any[]) => Promise<{ response: number; checkboxChecked: boolean }>;
  showMessageBoxSync: (...args: any[]) => number;
  showErrorBox: (title: string, content: string) => void;
}

/** The parts of Electron's shell module replaced. */
export interface ShellLike {
  openExternal: (url: string, options?: any) => Promise<void>;
  showItemInFolder: (path: string) => void;
  openPath: (path: string) => Promise<string>;
}

/** 'file', 'folder', or null when nothing is there. */
export type PathKind = (path: string) => 'file' | 'folder' | null;

const pathKind: PathKind = (path) => {
  try {
    return statSync(path).isDirectory() ? 'folder' : 'file';
  } catch {
    return null;
  }
};

export interface DesktopOptions {
  /** How many events are kept. */
  limit?: number;
  now?: () => string;
  kind?: PathKind;
}

const DIALOGS: DialogKind[] = ['open', 'save', 'message'];
const SELECTIONS: Selection[] = ['file', 'files', 'folder', 'fileOrFolder'];
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Electron's (window?, options) argument forms. */
function splitArgs(args: unknown[]): { window: number | null; options: Record<string, any> } {
  if (args.length >= 2) {
    const w = args[0] as { id?: unknown } | null | undefined;
    return { window: w && typeof w.id === 'number' ? w.id : null, options: (args[1] as Record<string, any>) ?? {} };
  }
  return { window: null, options: (args[0] as Record<string, any>) ?? {} };
}

/** The button Esc presses: cancelId, else the first labelled Cancel or No, else 0 (Electron's rule). */
export function cancelButton(buttons: string[], cancelId: unknown): number {
  if (typeof cancelId === 'number' && Number.isInteger(cancelId)) return cancelId;
  const i = buttons.findIndex((b) => /^(cancel|no)$/i.test(b.replace(/&/g, '').trim()));
  return i >= 0 ? i : 0;
}

/** What an open chooser with these properties takes. Electron's own default, with neither asked for, is one file. */
export function selectionOf(properties: unknown): Selection {
  const props = Array.isArray(properties) ? properties : [];
  const folders = props.includes('openDirectory');
  const files = props.includes('openFile') || !folders;
  if (files && folders) return 'fileOrFolder';
  if (folders) return 'folder';
  return props.includes('multiSelections') ? 'files' : 'file';
}

/** Check one answer's shape; throws with what is wrong. */
export function checkAnswer(a: unknown): Answer {
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('An answer is an object.');
  const x = a as Record<string, unknown>;
  const known = new Set(['dialog', 'title', 'message', 'selection', 'cancel', 'paths', 'path', 'overwrite', 'button', 'checkbox']);
  for (const k of Object.keys(x)) if (!known.has(k)) throw new Error(`An answer does not take "${k}".`);
  if (!DIALOGS.includes(x.dialog as DialogKind)) throw new Error('"dialog" is open, save or message.');
  for (const k of ['title', 'message'] as const) if (x[k] !== undefined && (typeof x[k] !== 'string' || !x[k])) throw new Error(`"${k}" is the chooser's own ${k}, a non-empty string.`);
  if (x.selection !== undefined && (x.dialog !== 'open' || !SELECTIONS.includes(x.selection as Selection))) throw new Error(`"selection" is one of ${SELECTIONS.join(', ')}, for an open chooser.`);
  const given = (['cancel', 'paths', 'path', 'button'] as const).filter((k) => x[k] !== undefined);
  if (given.length !== 1) throw new Error('An answer has exactly one of cancel, paths, path or button.');
  if (x.cancel !== undefined && x.cancel !== true) throw new Error('"cancel" is true when given.');
  if (x.paths !== undefined) {
    if (x.dialog !== 'open') throw new Error('"paths" answers an open chooser.');
    if (!Array.isArray(x.paths) || !x.paths.length || !x.paths.every((p) => typeof p === 'string' && isAbsolute(p))) throw new Error('"paths" is a non-empty list of absolute paths.');
  }
  if (x.path !== undefined) {
    if (x.dialog !== 'save') throw new Error('"path" answers a save chooser.');
    if (typeof x.path !== 'string' || !isAbsolute(x.path)) throw new Error('"path" is an absolute path.');
  }
  if (x.overwrite !== undefined && (x.dialog !== 'save' || (x.overwrite !== 'replace' && x.overwrite !== 'decline'))) throw new Error('"overwrite" is replace or decline, for a save chooser.');
  if (x.button !== undefined && (x.dialog !== 'message' || typeof x.button !== 'string' || !x.button)) throw new Error('"button" is the label of a button, for a message chooser.');
  if (x.checkbox !== undefined && (x.dialog !== 'message' || typeof x.checkbox !== 'boolean')) throw new Error('"checkbox" is true or false, for a message chooser.');
  const out: Answer = { dialog: x.dialog as DialogKind };
  for (const k of ['title', 'message', 'selection', 'cancel', 'paths', 'path', 'overwrite', 'button', 'checkbox'] as const) if (x[k] !== undefined) (out as any)[k] = Array.isArray(x[k]) ? [...(x[k] as string[])] : x[k];
  return out;
}

/** Whether `file` passes the chooser's filters (none, or one listing '*', passes everything). */
function filtered(file: string, filters: FileFilter[] | undefined): boolean {
  if (!filters?.length) return true;
  const ext = extname(file).slice(1).toLowerCase();
  return filters.some((f) => f.extensions.some((e) => e === '*' || e.toLowerCase() === ext));
}

const describeAnswer = (a: QueuedAnswer) =>
  `${a.id} (a ${a.dialog} chooser${a.title ? ` titled ${JSON.stringify(a.title)}` : ''}${a.message ? ` saying ${JSON.stringify(a.message)}` : ''}${a.selection ? ` taking ${a.selection}` : ''})`;

export function createDesktopFixtures(opts: DesktopOptions = {}) {
  const limit = opts.limit ?? 500;
  const now = opts.now ?? (() => new Date().toISOString());
  const kind = opts.kind ?? pathKind;
  let queue: QueuedAnswer[] = [];
  let log: DesktopEvent[] = [];
  let dropped = 0;
  let seq = 0;
  let ids = 0;
  /** The editor window open now, which a batch set now belongs to. */
  let editor: number | null = null;

  const record = <E extends DesktopEvent>(e: Omit<E, 'seq' | 'at'>): E => {
    const full = { seq: ++seq, at: now(), ...e } as E;
    log.push(full);
    if (log.length > limit) {
      log = log.slice(log.length - limit);
      dropped = full.seq - limit;
    }
    return full;
  };

  const chooser = (dialog: ChooserEvent['dialog'], sync: boolean, window: number | null, o: Record<string, any>) => ({
    type: 'chooser' as const,
    dialog,
    sync,
    window,
    title: str(o.title),
    message: str(o.message),
    detail: str(o.detail),
    buttonLabel: str(o.buttonLabel),
    defaultPath: str(o.defaultPath)
  });

  /**
   * The answer for this chooser, taken from the head of the batch, or why there is none (the event says so). A head
   * meant for another chooser stays where it is.
   */
  const take = (e: Omit<ChooserEvent, 'seq' | 'at'>): QueuedAnswer | null => {
    const head = queue[0];
    if (!head) {
      e.outcome = 'unanswered';
      e.reason = `No answer was set for this ${e.dialog} chooser; it was closed without a choice.`;
      return null;
    }
    const differs: string[] = [];
    if (head.dialog !== e.dialog) differs.push(`it is a ${e.dialog} chooser`);
    if (head.title !== undefined && head.title !== e.title) differs.push(`its title is ${JSON.stringify(e.title)}`);
    if (head.message !== undefined && head.message !== e.message) differs.push(`its message is ${JSON.stringify(e.message)}`);
    if (head.selection !== undefined && head.selection !== e.selection) differs.push(`it takes ${e.selection}`);
    if (differs.length) {
      e.outcome = 'mismatched';
      e.answer = head.id;
      e.request = head.request;
      e.reason = `The next answer, ${describeAnswer(head)}, is not for this chooser: ${differs.join(', ')}. It was closed without a choice, and the answer is kept for its own chooser.`;
      return null;
    }
    queue.shift();
    e.answer = head.id;
    e.request = head.request;
    return head;
  };

  const filtersOf = (o: Record<string, any>): FileFilter[] | undefined =>
    Array.isArray(o.filters) ? o.filters.map((f: FileFilter) => ({ name: String(f?.name ?? ''), extensions: Array.isArray(f?.extensions) ? f.extensions.map(String) : [] })) : undefined;

  function open(args: unknown[], sync: boolean): string[] | null {
    const { window, options } = splitArgs(args);
    const selection = selectionOf(options.properties);
    const filters = filtersOf(options);
    const e = { ...chooser('open', sync, window, options), selection, ...(filters ? { filters } : {}), outcome: 'unanswered', answer: null, request: null, result: null } as Omit<ChooserEvent, 'seq' | 'at'>;
    const a = take(e);
    let chosen: string[] | null = null;
    if (a?.cancel) e.outcome = 'cancelled';
    else if (a) {
      const folders = selection === 'folder' || selection === 'fileOrFolder';
      const files = selection !== 'folder';
      const paths = a.paths!;
      const problem =
        paths.length > 1 && selection !== 'files'
          ? `it takes one ${selection === 'folder' ? 'folder' : selection === 'file' ? 'file' : 'file or folder'}, and ${paths.length} were given`
          : (paths
              .map((p) => {
                const k = kind(p);
                if (!k) return `${p} does not exist`;
                if (k === 'folder' && !folders) return `${p} is a folder, and it takes files`;
                if (k === 'file' && !files) return `${p} is a file, and it takes folders`;
                if (k === 'file' && !filtered(p, filters)) return `${p} is not a type its filters offer`;
                return null;
              })
              .find((x) => x) ?? null);
      if (problem) {
        e.outcome = 'refused';
        e.reason = `The answer could not be chosen here: ${problem}. It was closed without a choice.`;
      } else {
        e.outcome = 'chosen';
        chosen = [...paths];
      }
    }
    e.result = { paths: chosen ?? [] };
    record<ChooserEvent>(e);
    return chosen;
  }

  function save(args: unknown[], sync: boolean): string | null {
    const { window, options } = splitArgs(args);
    const filters = filtersOf(options);
    const e = { ...chooser('save', sync, window, options), ...(filters ? { filters } : {}), outcome: 'unanswered', answer: null, request: null, result: null } as Omit<ChooserEvent, 'seq' | 'at'>;
    const a = take(e);
    let chosen: string | null = null;
    if (a?.cancel) e.outcome = 'cancelled';
    else if (a) {
      const path = a.path!;
      const here = kind(path);
      if (kind(dirname(path)) !== 'folder') {
        e.outcome = 'refused';
        e.reason = `The answer could not be chosen here: ${dirname(path)} is not a folder. It was closed without a choice.`;
      } else if (here === 'folder') {
        e.outcome = 'refused';
        e.reason = `The answer could not be chosen here: ${path} is a folder. It was closed without a choice.`;
      } else if (here === 'file' && a.overwrite !== 'replace') {
        // The system asks before replacing a file; declining leaves nothing chosen.
        e.outcome = 'cancelled';
        e.reason = `${path} already exists, and the system's question whether to replace it was ${a.overwrite === 'decline' ? 'declined' : 'not answered, so declined'}.`;
      } else {
        e.outcome = 'chosen';
        chosen = path;
      }
    }
    e.result = { path: chosen };
    record<ChooserEvent>(e);
    return chosen;
  }

  function message(args: unknown[], sync: boolean): { response: number; checkboxChecked: boolean } {
    const { window, options } = splitArgs(args);
    const buttons: string[] = Array.isArray(options.buttons) && options.buttons.length ? options.buttons.map(String) : ['OK'];
    const cancelId = cancelButton(buttons, options.cancelId);
    const e = { ...chooser('message', sync, window, options), buttons, cancelId, outcome: 'unanswered', answer: null, request: null, result: null } as Omit<ChooserEvent, 'seq' | 'at'>;
    let response = cancelId;
    let checkbox = options.checkboxChecked === true;
    if ((options.signal as AbortSignal | undefined)?.aborted) {
      // The app took the message back before it could be answered: no answer is used.
      e.outcome = 'cancelled';
      e.reason = 'The app closed the message itself.';
    } else {
      const a = take(e);
      if (a?.cancel) e.outcome = 'cancelled';
      else if (a) {
        const i = buttons.findIndex((b) => b === a.button || b.replace(/&/g, '') === a.button);
        if (i < 0) {
          e.outcome = 'refused';
          e.reason = `The answer could not be chosen here: there is no ${JSON.stringify(a.button)} button (there are ${buttons.map((b) => JSON.stringify(b)).join(', ')}). It was closed with its cancel button.`;
        } else {
          e.outcome = 'chosen';
          response = i;
          if (a.checkbox !== undefined) checkbox = a.checkbox;
        }
      }
    }
    e.result = { button: response, label: buttons[response] ?? null, checkbox };
    record<ChooserEvent>(e);
    return { response, checkboxChecked: checkbox };
  }

  function errorBox(title: unknown, content: unknown) {
    record<ChooserEvent>({ ...chooser('error', true, null, { title, detail: content }), outcome: 'closed', answer: null, request: null, result: null });
  }

  const intent = (k: IntentEvent['kind'], target: unknown) => void record<IntentEvent>({ type: 'intent', kind: k, target: String(target) });

  /** Whatever is left of the batch for `window` expires. */
  const expire = (window: number) => {
    const gone = queue.filter((a) => a.window === window);
    if (!gone.length) return;
    queue = queue.filter((a) => a.window !== window);
    record<AnswersEvent>({ type: 'answers', change: 'expired', answers: gone.map((a) => a.id), window, request: null });
  };

  const fixtures: DesktopFixtures = {
    setAnswers(answers, { request = null } = {}) {
      if (!Array.isArray(answers)) throw new Error('Answers are a list.');
      const checked = answers.map((a, i) => {
        try {
          return checkAnswer(a);
        } catch (e) {
          throw new Error(`Answer ${i + 1}: ${(e as Error).message}`);
        }
      });
      const replaced = queue.map((a) => a.id);
      queue = checked.map((a) => ({ ...a, id: `answer-${++ids}`, request, window: editor }));
      record<AnswersEvent>({ type: 'answers', change: 'set', answers: queue.map((a) => a.id), replaced, window: editor, request });
      return queue.map((a) => a.id);
    },
    events(after = 0, max = 200) {
      const entries = log.filter((e) => e.seq > after).slice(0, Math.max(1, max));
      return { entries: structuredClone(entries), next: entries.length ? entries[entries.length - 1].seq : after, dropped, pending: structuredClone(queue) };
    },
    noteMenu(path, window, request = null) {
      return record<MenuEvent>({ type: 'menu', path: [...path], window, request }).seq;
    },
    get seq() {
      return seq;
    }
  };

  const dialog: DialogLike = {
    showOpenDialog: async (...args) => {
      const chosen = open(args, false);
      return { canceled: !chosen, filePaths: chosen ?? [] };
    },
    showOpenDialogSync: (...args) => open(args, true) ?? undefined,
    showSaveDialog: async (...args) => {
      const chosen = save(args, false);
      return { canceled: !chosen, filePath: chosen ?? '' };
    },
    showSaveDialogSync: (...args) => save(args, true) ?? '',
    showMessageBox: async (...args) => message(args, false),
    showMessageBoxSync: (...args) => message(args, true).response,
    showErrorBox: (title, content) => errorBox(title, content)
  };

  const shell: ShellLike = {
    openExternal: async (url) => intent('open-external', url),
    showItemInFolder: (path) => intent('reveal', path),
    openPath: async (path) => {
      intent('open-path', path);
      return '';
    }
  };

  /** The app's editor window comes and goes. */
  const windows = {
    /** An editor window opened: a batch set while there was none belongs to it. */
    opened(window: number) {
      editor = window;
      for (const a of queue) if (a.window === null) a.window = window;
    },
    /** It closed, or a new page replaced its editor: what is left of its batch expires. */
    gone(window: number, { closed }: { closed: boolean }) {
      expire(window);
      if (closed && editor === window) editor = null;
    }
  };

  return { fixtures, dialog, shell, windows };
}

export type HeadlessDesktop = ReturnType<typeof createDesktopFixtures>;

/**
 * Replace Electron's dialogs and desktop hand-offs with the fixtures, and publish them on globalThis. Call it only in
 * an automated run, before anything can show a dialog. The replaced methods stay writable, so a test may still stand
 * in for one itself.
 */
export function installHeadlessDesktop(electron: { dialog: DialogLike; shell: ShellLike }, opts: DesktopOptions = {}): HeadlessDesktop {
  const desktop = createDesktopFixtures(opts);
  Object.assign(electron.dialog, desktop.dialog);
  Object.assign(electron.shell, desktop.shell);
  (globalThis as Record<symbol, unknown>)[DESKTOP_FIXTURES] = desktop.fixtures;
  return desktop;
}
