/**
 * The arguments each driver operation takes, as JSON Schema (2020-12): what a client may send in a request's `args`.
 * They describe the driver's own parsers (session.ts, observe.ts, act.ts, desktop.ts), which stay the authority: a
 * request is checked there, in the same order for every client, whatever a schema says. The MCP server (mcp.ts)
 * advertises them as its tools' input schemas.
 *
 * Every operation needs one: INPUT_SCHEMAS is keyed by the catalog's names, so an operation added to operations.ts
 * without a schema does not type-check. The root of each is a plain object (no oneOf at the top), which every MCP
 * client and model function-calling API accepts; alternatives live inside properties, and the rules between fields
 * (a ref alone, or a role) are in the descriptions.
 */
import type { OpName } from './operations.ts';
import { CONDITIONS } from './outcomes.ts';
import { MAX_TIMEOUT_MS } from './protocol.ts';

export interface JsonSchema {
  [key: string]: unknown;
}

const object = (properties: Record<string, JsonSchema>, required: string[] = [], description?: string): JsonSchema => ({
  type: 'object',
  ...(description ? { description } : {}),
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false
});

const REF = { type: 'string', pattern: '^[0-9a-f]{6}:\\d+$', description: 'A ref an observation gave (ui.snapshot, ui.locate, ui.waitFor), such as "a1b2c3:12".' };
const SCOPE = { type: 'string', enum: ['editor', 'preview', 'all'], description: 'Where to look: the editor\'s own UI, the live preview of the site, or both (default "all").' };
const KEEP = { type: 'string', enum: ['always', 'on-failure', 'never'] };
const WAIT_MS = { type: 'integer', minimum: 0, maximum: 10_000, description: 'How long to wait for the target to become actionable, in ms (default 3000).' };
const XY = (min: number, max: number, description: string) => object({ x: { type: 'number', minimum: min, maximum: max }, y: { type: 'number', minimum: min, maximum: max } }, ['x', 'y'], description);
const REF_TARGET = object({ ref: REF }, ['ref'], 'An element an observation gave a ref for.');
const POINTER_TARGET = {
  description: 'An element by ref (aimed at its middle, or at "position" from its top-left), or a point on the latest screenshot an observation saved.',
  anyOf: [
    object({ ref: REF, position: XY(0, 100_000, 'CSS pixels from the element\'s top-left corner, inside its box.') }, ['ref']),
    object(
      {
        observation: { type: 'string', pattern: '^o[0-9a-f]{6}-\\d{1,9}$', description: 'The screenshots\' "observation" token.' },
        surface: { type: 'string', enum: ['editor', 'preview'], description: 'The image the point is on.' },
        x: { type: 'number', minimum: 0, maximum: 100_000 },
        y: { type: 'number', minimum: 0, maximum: 100_000 }
      },
      ['observation', 'surface', 'x', 'y']
    )
  ]
};
const SEARCH = {
  ref: REF,
  role: { type: 'string', pattern: '^[a-z]+$', description: 'An ARIA role, such as "button", "textbox" or "dialog".' },
  name: { type: 'string', minLength: 1, description: 'Its accessible name.' },
  exact: { type: 'boolean', description: 'Match the name exactly (default, after collapsing whitespace), or false for a case-insensitive substring.' },
  region: { type: 'string', minLength: 1, description: 'Only inside a region: its role, its name, or role "name", as region paths show them.' },
  within: { ...REF, description: 'Only inside the element this ref names (searches its own scope).' },
  scope: SCOPE
};
const ANSWER = object(
  {
    dialog: { type: 'string', enum: ['open', 'save', 'message'] },
    title: { type: 'string', minLength: 1, description: 'Only the chooser with this title.' },
    message: { type: 'string', minLength: 1, description: 'Only the chooser with this message.' },
    selection: { type: 'string', enum: ['file', 'files', 'folder', 'fileOrFolder'], description: 'What an open chooser picks.' },
    cancel: { const: true, description: 'Cancel it.' },
    paths: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, description: 'Open: session paths, such as "workspace" or "imports/photo.jpg".' },
    path: { type: 'string', minLength: 1, description: 'Save: a session path, such as "exports/site.zip".' },
    overwrite: { type: 'string', enum: ['replace', 'decline'], description: 'Save: the answer to the system\'s Replace? question.' },
    button: { type: 'string', minLength: 1, description: 'Message: the label of the button pressed.' },
    checkbox: { type: 'boolean', description: 'Message: the checkbox, beside "button".' }
  },
  ['dialog'],
  'One chooser\'s answer: exactly one of cancel, paths (open), path (save) or button (message).'
);

export const INPUT_SCHEMAS: Record<OpName, JsonSchema> = {
  'session.start': object({
    fixture: { type: 'string', enum: ['welcome', 'business-v1'], description: 'The state the app opens in: the Welcome screen (default) or a named, reproducible project.' },
    provider: { type: 'string', enum: ['scripted', 'none'], description: 'The AI provider: a scripted local server that costs nothing (default), or none.' },
    keepArtifacts: { ...KEEP, description: 'When the session\'s artifacts outlive it (default "on-failure").' },
    artifactsDir: { type: 'string', minLength: 1, description: 'An absolute folder the caller owns, to hold this session\'s artifacts in a new child folder.' },
    headed: { type: 'boolean', description: 'Show the window, for a person debugging a script.' }
  }),
  'session.describe': object({}),
  'window.info': object({}),
  'window.close': object({}),
  'menu.list': object({}),
  'menu.invoke': object({ path: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 }, description: 'The item\'s labels from the menu bar down, such as ["File", "Open Project…"].' } }, ['path']),
  'desktop.setAnswers': object({ answers: { type: 'array', items: ANSWER, description: 'In order; [] clears them.' } }, ['answers']),
  'desktop.events': object({ after: { type: 'integer', minimum: 0, description: 'A cursor from an earlier reply (default 0).' }, limit: { type: 'integer', minimum: 1, maximum: 1000 } }),
  'files.stageImport': object(
    { sample: { type: 'string', minLength: 1, description: 'One of the starter\'s photos, such as "hero.jpg".' }, name: { type: 'string', minLength: 1, description: 'The file\'s name in imports/ (default the sample\'s), with the same extension.' } },
    ['sample']
  ),
  'files.list': object({ path: { type: 'string', minLength: 1, description: 'A session folder: exports (default), imports or workspace, or one inside them.' } }),
  'ui.snapshot': object({
    scope: SCOPE,
    within: { ...REF, description: 'Show what is inside this ref (in its own scope: leave "scope" out).' },
    after: { ...REF, description: 'Continue after this ref among its siblings (a continuation\'s "after").' },
    offset: { type: 'integer', minimum: 0, maximum: 1_000_000, description: 'Continue from this index among the siblings (a continuation\'s "offset").' },
    maxNodes: { type: 'integer', minimum: 1, maximum: 1000, description: 'The most nodes to return (default 200).' },
    depth: { type: 'integer', minimum: 0, maximum: 50, description: 'Levels below the roots to return.' },
    screenshot: { type: 'boolean', description: 'Also save PNGs of the editor window and the preview; read them with evidence.read.' }
  }),
  'ui.locate': object(SEARCH, [], 'A "ref" alone (to look at it again), or a "role" with optional name, exact, and one of region or within, and scope.'),
  'ui.waitFor': object(
    { ...SEARCH, state: { type: 'string', enum: ['present', 'absent'], description: 'Wait until one element matches (default "present"), or until none does. A ref waits only for "absent".' } },
    [],
    'What to wait for: a "role" search as ui.locate takes, or for "absent" a "ref" alone. The request\'s timeoutMs bounds the wait.'
  ),
  'evidence.read': object({ id: { type: 'string', minLength: 1, description: 'An evidence id from a screenshot (ui.snapshot screenshots.editor.id or .preview.id).' } }, ['id']),
  'ui.click': object(
    {
      target: POINTER_TARGET,
      button: { type: 'string', enum: ['left', 'right'] },
      count: { type: 'integer', enum: [1, 2], description: '2 is a double click (left button only).' },
      modifiers: { type: 'array', maxItems: 4, items: { type: 'string', enum: ['Alt', 'Control', 'Meta', 'Shift', 'ControlOrMeta'] }, description: 'Held while clicking.' },
      waitMs: WAIT_MS
    },
    ['target']
  ),
  'ui.hover': object({ target: POINTER_TARGET, waitMs: WAIT_MS }, ['target']),
  'ui.fill': object({ target: REF_TARGET, text: { type: 'string', maxLength: 100_000, description: 'The new contents; empty clears it.' }, waitMs: WAIT_MS }, ['target', 'text']),
  'ui.type': object(
    { target: { ...REF_TARGET, description: 'Type into this element; without it, into what has the keyboard focus.' }, text: { type: 'string', minLength: 1, maxLength: 2000 }, waitMs: WAIT_MS },
    ['text']
  ),
  'ui.select': object(
    {
      target: REF_TARGET,
      option: { description: 'The option, by its label or its value.', anyOf: [object({ label: { type: 'string' } }, ['label']), object({ value: { type: 'string' } }, ['value'])] },
      waitMs: WAIT_MS
    },
    ['target', 'option']
  ),
  'ui.press': object(
    {
      key: { type: 'string', minLength: 1, maxLength: 100, description: 'One key chord: modifiers then a key, joined by "+", such as "Escape", "Shift+Tab" or "ControlOrMeta+z".' },
      target: { ...REF_TARGET, description: 'Press it on this element; without it, on what has the keyboard focus.' },
      waitMs: WAIT_MS
    },
    ['key']
  ),
  'ui.scroll': object(
    { target: POINTER_TARGET, deltaX: { type: 'number', minimum: -10_000, maximum: 10_000 }, deltaY: { type: 'number', minimum: -10_000, maximum: 10_000, description: 'CSS pixels; positive scrolls down.' }, waitMs: WAIT_MS },
    ['target']
  ),
  'ui.drag': object(
    {
      from: POINTER_TARGET,
      to: { ...POINTER_TARGET, description: 'Where to release: a drop target. Give "to" or "by", not both.' },
      by: XY(-10_000, 10_000, 'An offset in the editor window\'s CSS pixels, for a handle that holds the pointer (a resize edge).'),
      steps: { type: 'integer', minimum: 1, maximum: 100, description: 'Pointer moves on the way (default 12).' },
      waitMs: WAIT_MS
    },
    ['from']
  ),
  'wait.for': object(
    {
      condition: { type: 'string', enum: [...CONDITIONS], description: 'The condition to wait for; the other properties are its params.' },
      role: { ...SEARCH.role, description: 'ui.present / ui.absent: an ARIA role to find, as ui.locate takes it (with name, exact, region, within, scope).' },
      name: SEARCH.name,
      exact: SEARCH.exact,
      region: SEARCH.region,
      within: SEARCH.within,
      scope: SEARCH.scope,
      screen: { type: 'string', enum: ['welcome', 'editor', 'other'], description: 'ui.context: the screen shown.' },
      mode: { enum: ['edit', 'preview', null], description: 'ui.context: the editor\'s mode, or null for none.' },
      dialog: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }], description: 'ui.context: the topmost dialog\'s name, or null for none.' },
      path: { type: 'string', pattern: '^/', description: 'preview.ready: the preview page\'s path, such as "/" or "/about/".' },
      changed: { type: 'boolean', description: 'save.settled: also require the project to have moved on since the last input (default true).' },
      atLeast: { type: 'integer', minimum: 0, description: 'project.revision: the revision to reach (default: above the one before the last input).' },
      since: { type: 'string', enum: ['input', 'start'], description: 'outcome.terminal: look since the last input (default) or since the start.' }
    },
    ['condition'],
    'A named condition with its params: ui.present / ui.absent take a role search (no ref); ui.context at least one of screen, mode and dialog. The request\'s timeoutMs bounds the wait.'
  ),
  'project.summary': object({ find: { type: 'string', minLength: 1, maxLength: 1000, description: 'Text to look for in every document string.' } }),
  'exports.inspect': object(
    {
      path: { type: 'string', minLength: 1, description: 'A session path in exports/, such as "exports/my-site-site".' },
      file: { type: 'string', minLength: 1, description: 'A file inside the folder, such as "index.html" (relative, no "." or "..").' },
      find: { type: 'string', minLength: 1, description: 'Text to search its text files (or the file) for.' },
      read: { type: 'boolean', description: 'Return the file\'s text.' }
    },
    ['path']
  ),
  'evidence.log': object({ after: { type: 'integer', minimum: 0, description: 'A cursor: the seq of the last entry already read (default 0).' }, limit: { type: 'integer', minimum: 1, maximum: 200, description: 'The most entries to return (default 100).' } }),
  'evidence.save': object({ screenshot: { type: 'boolean', description: 'Include screenshots with the latest observation (default true; withheld while a credential is known).' } }),
  'session.close': object({ keepArtifacts: { ...KEEP, description: 'Overrides the session\'s keepArtifacts for this close.' }, failed: { type: 'boolean', description: 'Marks the run as failed, for "on-failure".' } })
};

/** The request's own options beside its args: every operation's deadline, and the window it must run against. */
export const REQUEST_OPTIONS = {
  timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS, description: 'The request\'s deadline in ms, instead of the operation\'s default.' },
  expectWindow: { type: 'integer', minimum: 1, description: 'Refuse to run against any editor window but this generation (WINDOW_REPLACED says which replaced it).' }
} as const;
