/**
 * The test driver's operations: what each is (its kind), how long it may take by default, whether it needs a started
 * app and runs against the bound window, and what it does. `session.describe` lists them as a session's capabilities,
 * and the MCP server (mcp.ts) advertises one tool for each.
 *
 * This file loads nothing of Playwright or the app (outcomes.ts, for wait.for's conditions, only types Playwright), so a
 * client can read the catalog without loading a session.
 */
import { CONDITIONS } from './outcomes.ts';
import type { Capability, OpKind } from './protocol.ts';

export const DEFAULT_STARTUP_MS = 180_000;

export interface OpSpec {
  kind: OpKind;
  defaultTimeoutMs: number;
  needsApp: boolean;
  usesWindow: boolean;
  summary: string;
}

/** The operations a session answers: `session.describe` lists them as its capabilities. */
const OPS = {
  'session.start': {
    kind: 'session',
    defaultTimeoutMs: DEFAULT_STARTUP_MS,
    needsApp: false,
    usesWindow: false,
    summary: 'Start the built app headless in a new profile and workspace, at Welcome or with a named fixture project. Its deadline covers the whole start; one that passes ends the session.'
  },
  'session.describe': {
    kind: 'session',
    defaultTimeoutMs: 15_000,
    needsApp: false,
    usesWindow: false,
    summary: 'The session, the build and the running app, the processes the session owns, and these capabilities.'
  },
  'window.info': {
    kind: 'observe',
    defaultTimeoutMs: 10_000,
    needsApp: true,
    usesWindow: true,
    summary: 'The bound editor window: generation, native id, address, title, visibility and size.'
  },
  'window.close': {
    kind: 'act',
    defaultTimeoutMs: 10_000,
    needsApp: true,
    usesWindow: true,
    summary: 'Close the bound editor window, as its close button does: the editor may first ask about unsaved work. On macOS the app keeps running with no window.'
  },
  'menu.list': {
    kind: 'observe',
    defaultTimeoutMs: 10_000,
    needsApp: true,
    usesWindow: false,
    summary: 'The native application menu: every item with its label path, id, role, enabled and visible state, accelerator, and whether menu.invoke can choose it.'
  },
  'menu.invoke': {
    kind: 'act',
    defaultTimeoutMs: 10_000,
    needsApp: true,
    usesWindow: true,
    summary: 'Choose an application menu item by its label path (["File", "Open Project…"]) through its own handler, for the bound editor window or, with none open, for none. Refused when it is missing, hidden, disabled or a system role.'
  },
  'desktop.setAnswers': {
    kind: 'fixture',
    defaultTimeoutMs: 10_000,
    needsApp: true,
    usesWindow: false,
    summary:
      'Set the answers for the next native choosers, in order, replacing any left ([] clears them). Each is { dialog: open|save|message, title?, message?, selection?: file|files|folder|fileOrFolder } with one of { cancel: true }, { paths } (open), { path, overwrite?: replace|decline } (save) or { button } (message). Paths are session paths: imports/…, exports/… or workspace/…. A chooser with no answer for it is closed without a choice; none is ever shown.'
  },
  'desktop.events': {
    kind: 'observe',
    defaultTimeoutMs: 10_000,
    needsApp: true,
    usesWindow: false,
    summary: 'What happened at the desktop after a cursor: each chooser shown and how it was answered, links, reveals and paths the app handed to the system, menu items chosen and answers set or expired. Also the answers still waiting.'
  },
  'files.stageImport': {
    kind: 'fixture',
    defaultTimeoutMs: 10_000,
    needsApp: true,
    usesWindow: false,
    summary: 'Copy a sample image into the session’s imports/ folder under a new name, for a chooser to be answered with. Never replaces a file.'
  },
  'files.list': {
    kind: 'observe',
    defaultTimeoutMs: 10_000,
    needsApp: true,
    usesWindow: false,
    summary: 'One level of a session folder (default exports/): each entry’s name, path, type and size.'
  },
  'ui.snapshot': {
    kind: 'observe',
    defaultTimeoutMs: 15_000,
    needsApp: true,
    usesWindow: true,
    summary:
      'The accessibility tree of the editor and of its live preview, bounded (maxNodes, depth) with refs to drill into (within, offset), plus the context: screen, mode, dialog, focus, preview state and the selection. Optionally saves screenshots of both.'
  },
  'ui.locate': {
    kind: 'observe',
    defaultTimeoutMs: 15_000,
    needsApp: true,
    usesWindow: true,
    summary: 'One element, by role and name (in a region or within a ref) or by a ref seen before, as it is now: its ref, states, box, regions and page ids. Several matches answer AMBIGUOUS_TARGET with candidates; an outdated ref, STALE_REF.'
  },
  'ui.waitFor': {
    kind: 'observe',
    defaultTimeoutMs: 15_000,
    needsApp: true,
    usesWindow: true,
    summary:
      'Wait, looking again and again, until one element fits a search as ui.locate takes it ({ role, name?, exact?, region? | within?, scope? }) and answer it as ui.locate would, or with { state: "absent" } until none does (a search, or a ref alone that has gone). Bounded by the request\'s timeoutMs; one that passes is TIMEOUT and the session goes on.'
  },
  'evidence.read': {
    kind: 'observe',
    defaultTimeoutMs: 15_000,
    needsApp: true,
    usesWindow: false,
    summary: 'One screenshot an observation saved, by its evidence id ({ id }: screenshots.editor.id or .preview.id), as base64 PNG with its size and hash. Every screenshot of the session can be read until it closes; none while a credential is known.'
  },
  'ui.click': {
    kind: 'act',
    defaultTimeoutMs: 15_000,
    needsApp: true,
    usesWindow: true,
    summary:
      'Click a target with the real pointer: { target: { ref, position? } or a screenshot point { observation, surface, x, y }, button?: left|right, count?: 1|2, modifiers?: [Shift, Alt, Control, Meta, ControlOrMeta] }. Waits up to waitMs (default 3000) for it to be visible, enabled, not under a dialog and not covered; else NOT_ACTIONABLE with nothing sent.'
  },
  'ui.hover': {
    kind: 'act',
    defaultTimeoutMs: 15_000,
    needsApp: true,
    usesWindow: true,
    summary: 'Move the pointer onto a target (a ref, or a screenshot point), once it is visible and not covered.'
  },
  'ui.fill': {
    kind: 'act',
    defaultTimeoutMs: 15_000,
    needsApp: true,
    usesWindow: true,
    summary: 'Replace the text of a field or of text being edited ({ target: { ref }, text }; empty text clears it): the focus goes to it, everything in it is selected and the text is inserted as typing would. Nothing is committed.'
  },
  'ui.type': {
    kind: 'act',
    defaultTimeoutMs: 30_000,
    needsApp: true,
    usesWindow: true,
    summary: 'Type text key by key ({ text, target?: { ref } }): into the target, keeping its caret when it already has the focus, or into what has the focus, which must take text. Stops if the focus moves while typing.'
  },
  'ui.select': {
    kind: 'act',
    defaultTimeoutMs: 15_000,
    needsApp: true,
    usesWindow: true,
    summary: 'Choose one option of a single-choice <select> ({ target: { ref }, option: { label } or { value } }) after putting the focus on it, as a person would. Other lists are chosen in with ui.click.'
  },
  'ui.press': {
    kind: 'act',
    defaultTimeoutMs: 15_000,
    needsApp: true,
    usesWindow: true,
    summary: 'Press one key chord ({ key: "Escape" | "Shift+Tab" | "ControlOrMeta+z" | ..., target?: { ref } }): on the target, after putting the focus on it, or on what has the focus now. The whole chord is checked before any key goes down.'
  },
  'ui.scroll': {
    kind: 'act',
    defaultTimeoutMs: 15_000,
    needsApp: true,
    usesWindow: true,
    summary: 'Turn the mouse wheel over a target that is in view ({ target, deltaX?, deltaY? } in CSS pixels): what scrolls is what a person\'s wheel would scroll there.'
  },
  'ui.drag': {
    kind: 'act',
    defaultTimeoutMs: 20_000,
    needsApp: true,
    usesWindow: true,
    summary:
      'Press on `from`, move to `to` (a drop target) or `by` an offset in the editor window\'s CSS pixels (a resize handle), in `steps` moves, and release: { from, to? | by?: { x, y }, steps? }. Both ends are checked before the button goes down; a drag that stops part way is cancelled (Escape) where it started.'
  },
  'wait.for': {
    kind: 'observe',
    defaultTimeoutMs: 30_000,
    needsApp: true,
    usesWindow: true,
    summary:
      `Wait, within the request's timeoutMs, for a named condition: { condition: ${CONDITIONS.join(' | ')}, ...its params }. ui.present / ui.absent take ui.locate's role, name, exact, region, within, scope; ui.context takes screen, mode, dialog (a name, or null); preview.ready takes path; save.settled (the editor shows Saved, and with changed (default true) the project moved on since the last input); project.revision takes atLeast (default: above the revision before the last input); export.finished (an export finished or failed since the last input: outcome exported | failed); outcome.terminal takes since: input | start (the app exited, the window closed, a page error, a preview failure). Answers with what met it, or TIMEOUT (retryable) with details: the pending condition, the last sample, an observation and the page, preview and app errors.`
  },
  'project.summary': {
    kind: 'observe',
    defaultTimeoutMs: 15_000,
    needsApp: true,
    usesWindow: true,
    summary:
      'The open project, read independently of its UI: its opening, revision, save indicator, preview runtime, history, conflicts and recent exports from the app, and its site and pages from the documents on disk. With find, every document string that holds the text (file and JSON path), bounded; complete says whether every document was read.'
  },
  'exports.inspect': {
    kind: 'observe',
    defaultTimeoutMs: 15_000,
    needsApp: true,
    usesWindow: false,
    summary:
      'Read what an export wrote into the session\'s exports/ folder: { path: "exports/...", file?: a file inside a folder, find?: text, read?: true }. A folder lists its files; find searches its text files (or the file) for the text, bounded, with complete saying whether everything was read. Links are never followed.'
  },
  'evidence.log': {
    kind: 'observe',
    defaultTimeoutMs: 10_000,
    needsApp: false,
    usesWindow: false,
    summary:
      'The session\'s ordered record of requests after a cursor ({ after?: seq, limit?: 1-200 }): each with its class (setup, input, observation, session), args, the targets of an input as role, name and region, and how it ended. Bounded: dropped counts entries let go.'
  },
  'evidence.save': {
    kind: 'observe',
    defaultTimeoutMs: 30_000,
    needsApp: false,
    usesWindow: false,
    summary:
      'Write replay.json into the session\'s artifacts and return it: the build, the fixture and provider scenario, every recorded step, the latest observation (with screenshots unless withheld or screenshot: false), the last failure, page errors and app output that read as trouble, and the artifacts. Credentials and host paths are left out. A session closing with its artifacts kept writes one too.'
  },
  'assistant.script': {
    kind: 'fixture',
    defaultTimeoutMs: 10_000,
    needsApp: true,
    usesWindow: false,
    summary:
      'Set what the scripted model answers, one model request per step: { scenario: answer|read-and-answer|interview|edit-selection|widen|fail, params } or { steps: [{ tool, args?, status?, gate?, delayMs? } | { error: { status, message? }, gate?, delayMs? }] }, mode?: append|replace. In args, { "$context": "selection.nodeId" } reads the editor context the request carries and { "$result": "nodeId" } its latest tool result. A gated step is held until assistant.release. Scripted sessions only.'
  },
  'assistant.release': {
    kind: 'fixture',
    defaultTimeoutMs: 10_000,
    needsApp: true,
    usesWindow: false,
    summary: 'Let the reply held at a gate go ({ gate }). Releasing it again changes nothing; a gate never scripted is TARGET_NOT_FOUND.'
  },
  'assistant.observe': {
    kind: 'observe',
    defaultTimeoutMs: 10_000,
    needsApp: true,
    usesWindow: false,
    summary:
      'What the assistant did after a cursor ({ after?, limit?, runId?, conversationId? }): ordered entries keyed by conversation, message and run (run.started with its request, status, step, question, answer, model, text, result), `next` to read on, each run as it stands (working, input, ending, terminal), what the chat panel shows by the same IDs (messages, the question card, the run strip, the composer, notices and errors), and the script’s gates.'
  },
  'assistant.wait': {
    kind: 'observe',
    defaultTimeoutMs: 30_000,
    needsApp: true,
    usesWindow: false,
    summary:
      'Wait until one run ({ runId, after? }) finishes or needs the author (a question, a request to change more), and say which (reason: terminal | input) with the run and, when its conversation is shown, its turn as rendered. Only that run’s events count. A question asked at or before `after` is not a new one. TIMEOUT (the session goes on) names where it stood.'
  },
  'session.close': {
    kind: 'session',
    defaultTimeoutMs: 60_000,
    needsApp: false,
    usesWindow: false,
    summary: 'Quit the app (killing it if it does not quit in time), end every process it started and remove the run-owned data, keeping artifacts when asked.'
  }
} satisfies Record<string, OpSpec>;

/** An operation's name, such as `ui.click`. */
export type OpName = keyof typeof OPS;

/** The operations a session answers, by name. */
export const OPERATIONS: Record<string, OpSpec> = OPS;

export function capabilities(): Capability[] {
  return Object.entries(OPERATIONS).map(([op, s]) => ({ op, kind: s.kind, defaultTimeoutMs: s.defaultTimeoutMs, needsApp: s.needsApp, usesWindow: s.usesWindow, summary: s.summary }));
}
