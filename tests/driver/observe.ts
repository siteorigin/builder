/**
 * UI observations for the test driver (issue #492): the half that reads the app. One observation reads both documents'
 * state (the editor's, and the preview's when there is one), takes Playwright's accessibility snapshot of the editor's
 * whole page (it enters the preview's iframe), reads both documents again, and redacts the raw tree before shaping it
 * (snapshot.ts). Refs are minted only from an observation whose documents and project did not change while it was
 * taken, and, for the preview, only once its page is hydrated, the canvas calls it ready, and the page has taken the
 * editor's current mode.
 *
 * Every lookup goes through a full snapshot because Playwright resolves its `aria-ref` selector against each frame's
 * last snapshot: observing everything each time keeps every element's ref resolvable, and Playwright keeps an
 * element's ref while its role and name stay the same, so the session's refs stay the same too.
 *
 * Credentials: every reply and every error an operation produces is scrubbed of every credential its observation
 * knows (scrubDeep), on top of the raw tree's own redaction. Screenshots are taken only while no credential is known
 * at all: pixels cannot be scrubbed, and a credential can be painted where no text check sees it.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ElementHandle, Frame, Locator, Page } from 'playwright';
import { DriverError } from './protocol.ts';
import type { LocateArgs, SnapshotArgs, UiScope, XY } from './protocol.ts';
import { readScene, sceneChange } from './shots.ts';
import type { Scene, ShotRegistry } from './shots.ts';
import {
  LIMITS,
  REFRESH_HINT,
  RefRegistry,
  choose,
  describe,
  dialogFrom,
  findByPwRef,
  focusFrom,
  looksLikeRef,
  redact,
  regionMatches,
  regionNodes,
  render,
  rootsLeft,
  scrubDeep,
  selectionToolbar,
  shape,
  valueRefs,
  walk
} from './snapshot.ts';
import type { Binding, Continuation, ElementFacts, RawNode, Scope, Semantic, Shaped, StaleReason, UiNode } from './snapshot.ts';

/**
 * The functions handed to `evaluate` run in the app's documents. This project is typed for Node, without the DOM's
 * types, so they reach the page through `globalThis`, typed loosely here.
 */
type Dom = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/** What an observation needs from the session. */
export interface ObserveEnv {
  page: Page;
  /** The bound window's generation. */
  generation: number;
  registry: RefRegistry;
  /** Where screenshots are saved, or null when the session has no artifacts folder. */
  artifacts: string | null;
  signal: AbortSignal;
  /** The provider keys the app has saved in this session's own profile: never returned either. Strict: a key file
   *  that exists but cannot be read throws. */
  storedSecrets?: (strict?: boolean) => Promise<string[]>;
  /** Told every credential an observation learns, so the session can keep them out of what else it reports. */
  remember?: (secrets: string[]) => void;
  /** Every credential the session has seen before: scrubbed from this observation too. */
  remembered?: () => string[];
  /** The session's screenshot points: a screenshot taken while the scene holds still becomes the one actions may aim at. */
  shots?: ShotRegistry;
}

/** The canvas's iframe: the live preview. */
export const PREVIEW_IFRAME = '.frame-box iframe';
/** Fields whose values are credentials, in any document. Playwright's CSS locators pierce open shadow roots too. */
export const SECRET_INPUTS = 'input[type="password" i], input[autocomplete*="password" i]';

interface EditorDoc {
  token: string;
  screen: 'welcome' | 'editor' | 'other';
  title: string;
  opening: string;
  /** The canvas's frame state, or null without a canvas. */
  frame: 'ready' | 'loading' | null;
  /** The canvas's selection attribute: null for none, '' for one not on this page, else its element ids as JSON. */
  selection: string | null;
  /** The selection itself, as the editor's store holds it (JSON), or null for none. */
  selected: string | null;
  /** Whether the canvas draws an outline around the selection now. */
  outlined: boolean;
  /** The editor's mode, from the canvas itself (not from text a credential could be scrubbed out of); null without one. */
  mode: 'edit' | 'preview' | null;
  secrets: string[];
  viewport: { width: number; height: number };
}

interface PreviewDoc {
  frame: Frame;
  token: string;
  path: string;
  /** The mode this document's bridge last took from the editor (it loads once the page is hydrated), or null. */
  bridge: string | null;
  editing: boolean;
  secrets: string[];
  viewport: { width: number; height: number };
}

export type PreviewState = 'absent' | 'loading' | 'ready';

interface Docs {
  editor: EditorDoc;
  /** Null when the canvas has no frame, or its document could not be read (between documents). */
  preview: PreviewDoc | null;
  /** Whether the canvas has a preview iframe at all. */
  iframe: boolean;
}

export interface Observation {
  docs: Docs;
  /** The documents as first read, before the snapshot. */
  first: Docs;
  editor: Shaped[];
  /** The preview's tree, or null when there is none. */
  preview: Shaped[] | null;
  previewState: PreviewState;
  /** The preview iframe's node in the editor tree. */
  previewIframe: Shaped | null;
  /** Every credential string the observation knows: every reply built from it is scrubbed of them. */
  secrets: string[];
  /** A credential showed somewhere other than its own field. */
  echoes: number;
}

/** Runs in a document: the values of every credential field in it, open shadow roots included. */
function secretsIn(secret: string): string[] {
  const w = globalThis as Dom;
  const out: string[] = [];
  const visit = (root: Dom) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.matches(secret) && el.value) out.push(String(el.value));
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };
  visit(w.document);
  return out;
}

async function readEditor(page: Page): Promise<EditorDoc> {
  const read = await page.evaluate((): Omit<EditorDoc, 'secrets'> => {
    const w = globalThis as Dom;
    const canvas = w.document.querySelector('main.canvas');
    const frame = canvas?.getAttribute('data-frame');
    return {
      // What tells this document apart from every other the window has shown (the same in every read below).
      token: `${w.performance.timeOrigin}|${w.location.pathname}${w.location.search}`,
      screen: w.document.querySelector('.editor') ? 'editor' : w.document.querySelector('.welcome') ? 'welcome' : 'other',
      title: w.document.title,
      opening: canvas?.getAttribute('data-opening') ?? '',
      frame: frame === 'ready' || frame === 'loading' ? frame : null,
      selection: canvas ? canvas.getAttribute('data-selection') : null,
      selected: canvas ? canvas.getAttribute('data-selected-ref') : null,
      outlined: !!canvas?.querySelector('.ov-selected'),
      mode: canvas ? (canvas.classList.contains('edit-mode') ? 'edit' : 'preview') : null,
      viewport: { width: w.innerWidth, height: w.innerHeight }
    };
  });
  return { ...read, secrets: await page.evaluate(secretsIn, SECRET_INPUTS) };
}

async function readPreview(page: Page): Promise<{ iframe: boolean; doc: PreviewDoc | null }> {
  const el = await page.$(PREVIEW_IFRAME).catch(() => null);
  if (!el) return { iframe: false, doc: null };
  try {
    const frame = await el.contentFrame();
    if (!frame) return { iframe: true, doc: null };
    const read = await frame.evaluate(() => {
      const w = globalThis as Dom;
      const html = w.document.documentElement;
      return {
        // A reload, or a page the site went to without one, is another document.
        token: `${w.performance.timeOrigin}|${w.location.pathname}${w.location.search}` as string,
        path: w.location.pathname as string,
        bridge: html.getAttribute('data-so-bridge') as string | null,
        editing: html.hasAttribute('data-so-editing') as boolean,
        viewport: { width: w.innerWidth as number, height: w.innerHeight as number }
      };
    });
    const secrets = await frame.evaluate(secretsIn, SECRET_INPUTS);
    return { iframe: true, doc: { frame, ...read, secrets } };
  } catch {
    // Between documents: the frame has no page to read yet.
    return { iframe: true, doc: null };
  } finally {
    await el.dispose().catch(() => undefined);
  }
}

/**
 * Runs in a document: the values its visible ordinary fields show (never a credential field's, nor a hidden input's),
 * open shadow roots included. A value one of them shows is reported through that field anyway.
 */
function plainIn(secret: string): string[] {
  const w = globalThis as Dom;
  const out: string[] = [];
  const visit = (root: Dom) => {
    for (const el of root.querySelectorAll('input, textarea, select')) {
      if (el.matches(secret) || String(el.type).toLowerCase() === 'hidden') continue;
      if (typeof el.checkVisibility === 'function' ? !el.checkVisibility({ visibilityProperty: true }) : !el.getClientRects().length) continue;
      if (el.tagName === 'SELECT') for (const o of el.selectedOptions) out.push(String(o.label || o.textContent || ''), String(o.value));
      else if (el.value) out.push(String(el.value));
    }
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) visit(el.shadowRoot);
  };
  visit(w.document);
  return out;
}

/** The values of ordinary fields in every frame of the window (frames that cannot be read give none). */
async function framePlain(page: Page): Promise<Set<string>> {
  const read = await Promise.all(page.frames().map((f) => f.evaluate(plainIn, SECRET_INPUTS).catch((): string[] => [])));
  return new Set(read.flat());
}

/** The credential values in every frame of the window: the editor's, the preview's and any other (failures skipped). */
export async function frameSecrets(page: Page, { strict = false }: { strict?: boolean } = {}): Promise<string[]> {
  // Strict: a frame that cannot be read fails the whole read, for a caller that must not take "unknown" as "none".
  const read = await Promise.all(page.frames().map((f) => (strict ? f.evaluate(secretsIn, SECRET_INPUTS) : f.evaluate(secretsIn, SECRET_INPUTS).catch((): string[] => []))));
  return read.flat();
}

async function readDocs(page: Page): Promise<Docs> {
  const [editor, preview] = await Promise.all([readEditor(page), readPreview(page)]);
  return { editor, preview: preview.doc, iframe: preview.iframe };
}

/** Runs in the element's own document (Playwright sends its source, so it uses nothing from outside). */
function factOf(el: Dom): ElementFacts {
  const w = globalThis as Dom;
  const auto = el.getAttribute('autocomplete') ?? '';
  const secret = el.tagName === 'INPUT' && (el.type === 'password' || /password/i.test(auto));
  const node = el.getAttribute('data-so-node');
  const items = el.getAttribute('data-so-items');
  // Scrolled out of a panel: entirely outside an ancestor that clips its overflow.
  let clipped = false;
  const r = el.getBoundingClientRect();
  if (r.width || r.height) {
    for (let p = el.parentElement; p && p !== w.document.documentElement && !clipped; p = p.parentElement) {
      const o = w.getComputedStyle(p);
      const c = p.getBoundingClientRect();
      // Each axis clips only if its overflow does.
      const clipsX = o.overflowX !== 'visible';
      const clipsY = o.overflowY !== 'visible';
      clipped = (clipsX && (r.right <= c.left || r.left >= c.right)) || (clipsY && (r.bottom <= c.top || r.top >= c.bottom));
    }
  }
  const num = (a: string) => {
    const v = Number.parseInt(el.getAttribute(a) ?? '', 10);
    return Number.isSafeInteger(v) ? v : undefined;
  };
  const setsize = num('aria-setsize');
  const posinset = num('aria-posinset');
  return {
    secret,
    blocked: !!el.closest('[inert]'),
    clipped,
    semantic: node !== null ? { ctx: el.getAttribute('data-so-ctx') ?? '', node, ...(items ? { items } : {}) } : null,
    ...(setsize !== undefined ? { setsize } : {}),
    ...(posinset !== undefined ? { posinset } : {})
  };
}

/**
 * Run `fn` on the element a Playwright ref names, or answer null when there is none. Only `evaluate` will do:
 * `aria-ref` is resolved against the snapshot Playwright keeps in its own isolated world, which `evaluateAll` does not
 * look in. Counted first, because `evaluate` would wait for an element that is not there.
 */
async function onRef<R>(page: Page, ref: string, fn: (el: Dom, arg: Dom) => R, arg: Dom): Promise<R | null> {
  const loc = page.locator(`aria-ref=${ref}`);
  try {
    if ((await loc.count()) !== 1) return null;
    return (await loc.evaluate(fn, arg, { timeout: 1000 })) as R;
  } catch {
    return null;
  }
}

/** Each ref's element facts, or null for one whose element could not be read. */
async function factsByRef(page: Page, refs: string[]): Promise<Map<string, ElementFacts | null>> {
  const unique = [...new Set(refs)];
  const read = await Promise.all(unique.map((ref) => onRef(page, ref, factOf, undefined)));
  return new Map(unique.map((ref, i) => [ref, read[i]]));
}

function aborted(signal: AbortSignal) {
  if (signal.aborted) throw new DriverError('TIMEOUT', 'The observation ran out of time.');
}

function changing(what: string): DriverError {
  return new DriverError('OP_FAILED', `${what} while it was observed; observe again.`, { retryable: true, details: { hint: REFRESH_HINT } });
}

/**
 * Observe the window. `before` runs after the documents are first read and before the snapshot: lookups that take
 * snapshots of their own (which replace a frame's last snapshot) go there, so the full snapshot is always the last.
 */
export async function observe(env: ObserveEnv, before?: (docs: Docs) => Promise<void>): Promise<Observation> {
  const { page, signal } = env;
  const first = await readDocs(page);
  if (before) await before(first);
  aborted(signal);
  const raw = (await page.locator('body').ariaSnapshotJSON({ mode: 'ai', boxes: true, signal })) as unknown as (RawNode | string)[];
  aborted(signal);
  const [docs, others, stored, plain] = await Promise.all([readDocs(page), frameSecrets(page), env.storedSecrets?.().catch((): string[] => []) ?? Promise.resolve([]), framePlain(page)]);
  if (docs.editor.token !== first.editor.token) throw changing('The editor reloaded');
  // The editor's document stays the same when another project opens in it: refs would be bound to the wrong one.
  if (docs.editor.opening !== first.editor.opening) throw changing('Another project opened');
  // Which iframe is the preview: the one the canvas shows.
  const iframes = [...walkRaw(raw)].filter((n) => n.role === 'iframe' && n.ref);
  const isPreview = await Promise.all(iframes.map((n) => onRef(page, n.ref!, (el, sel: string) => !!el.matches(sel), PREVIEW_IFRAME)));
  const previewRaw = iframes.find((_, i) => isPreview[i]) ?? null;
  // Credentials leave nothing behind: the values of secret fields, and of fields that could not be classified, go,
  // and so does every echo of them anywhere.
  const valued = valueRefs(raw);
  const classified = await factsByRef(page, valued);
  const secretRefs = new Set(valued.filter((r) => classified.get(r)?.secret));
  const unknownRefs = new Set(valued.filter((r) => !classified.get(r)));
  // A field with no ref (Playwright gives none to the editor's fields while a menu is open) or one that could not be read
  // is told apart by its value: one an ordinary field holds now, and no credential field, is not a secret. Anything
  // else it could be is remembered for the rest of the session, as a credential is.
  const redacted = redact(raw, {
    secretRefs,
    unknownRefs,
    secrets: [...first.editor.secrets, ...docs.editor.secrets, ...(first.preview?.secrets ?? []), ...(docs.preview?.secrets ?? []), ...others, ...stored, ...(env.remembered?.() ?? [])],
    plain
  });
  env.remember?.(redacted.secrets);
  const editor = shape(raw, 'editor');
  // An iframe Playwright could not enter has no children: its page is not there to observe yet.
  const preview = previewRaw?.children?.length ? shape(previewRaw.children, 'preview') : null;
  const previewIframe = previewRaw?.ref ? findByPwRef(editor, previewRaw.ref) : null;
  // Ready: the page is hydrated and has taken the editor's current mode, the canvas calls it ready, and it stayed the
  // same document throughout.
  if (first.editor.mode !== docs.editor.mode) throw changing('The editor changed mode');
  const mode = docs.editor.mode;
  let previewState: PreviewState = 'ready';
  if (!docs.iframe) previewState = 'absent';
  else if (
    !docs.preview ||
    !first.preview ||
    !docs.preview.bridge ||
    // The page took the editor's mode before the snapshot, and still had it after.
    first.preview.bridge !== docs.preview.bridge ||
    (mode && docs.preview.bridge !== mode) ||
    docs.editor.frame !== 'ready' ||
    first.preview.token !== docs.preview.token ||
    !preview
  )
    previewState = 'loading';
  return { docs, first, editor, preview, previewState, previewIframe, secrets: redacted.secrets, echoes: redacted.echoes };
}

function* walkRaw(nodes: (RawNode | string)[] | undefined): Generator<RawNode> {
  for (const n of nodes ?? []) {
    if (typeof n === 'string') continue;
    yield n;
    // An iframe's children are another document; only the canvas's own iframes are looked at, at the top level.
    if (n.role !== 'iframe') yield* walkRaw(n.children);
  }
}

/**
 * Run an operation so nothing it returns or throws carries a credential its observations saw. `seen` collects them as
 * the operation observes; an error that is not the driver's own is reported by its first line only.
 */
export async function sealed<T>(run: (seen: string[]) => Promise<T>, { result = true }: { result?: boolean } = {}): Promise<T> {
  const seen: string[] = [];
  try {
    const out = await run(seen);
    return result ? scrubDeep(out, seen) : out;
  } catch (e) {
    if (e instanceof DriverError) throw new DriverError(e.code, scrubDeep(e.message, seen), { retryable: e.retryable, ...(e.details ? { details: scrubDeep(e.details, seen) } : {}) });
    throw new DriverError('OP_FAILED', scrubDeep(e instanceof Error ? e.message.split('\n')[0] : String(e), seen));
  }
}

async function observeInto(env: ObserveEnv, seen: string[], before?: (docs: Docs) => Promise<void>): Promise<Observation> {
  const obs = await observe(env, before);
  seen.push(...obs.secrets);
  return obs;
}

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

function stale(reason: StaleReason, ref: string, message: string): DriverError {
  return new DriverError('STALE_REF', message, { details: { ref, reason, hint: REFRESH_HINT } });
}

class Minter {
  readonly facts = new Map<Shaped, ElementFacts>();
  private readonly env: ObserveEnv;
  private readonly obs: Observation;
  /** A modal dialog over the editor covers its preview too: the frame's own elements cannot tell. */
  private previewBlocked: boolean | null = null;
  constructor(env: ObserveEnv, obs: Observation) {
    this.env = env;
    this.obs = obs;
  }

  /** Read the facts of every node that may get a ref, or be described. */
  async read(nodes: Iterable<Shaped>) {
    if (this.previewBlocked === null) {
      const iframe = this.obs.previewIframe?.pwRef;
      this.previewBlocked = iframe ? !!(await onRef(this.env.page, iframe, factOf, undefined))?.blocked : false;
    }
    const want = [...new Set(nodes)].filter((n) => n.pwRef && !this.facts.has(n));
    const facts = await factsByRef(this.env.page, want.map((n) => n.pwRef!));
    for (const n of want) {
      const f = facts.get(n.pwRef!);
      if (!f) continue;
      if (n.scope === 'preview' && this.previewBlocked) f.blocked = true;
      this.facts.set(n, f);
    }
  }

  /**
   * The node's ref; null for one that may not have one: no Playwright ref, a preview that is not ready, or an element
   * whose facts could not be read (its page ids would be unknown, and a ref must say what it stood for).
   */
  ref(n: Shaped): string | null {
    if (!n.pwRef || this.env.signal.aborted) return null;
    const { docs, previewState } = this.obs;
    if (n.scope === 'preview' && (previewState !== 'ready' || !docs.preview)) return null;
    const facts = this.facts.get(n);
    if (!facts) return null;
    return this.env.registry.mint({
      generation: this.env.generation,
      scope: n.scope,
      opening: docs.editor.opening,
      doc: n.scope === 'editor' ? docs.editor.token : docs.preview!.token,
      pwRef: n.pwRef,
      role: n.role,
      name: n.name ?? '',
      semantic: facts.semantic ? JSON.stringify(facts.semantic) : null,
      regions: n.regions
    });
  }

  describe(n: Shaped): UiNode {
    return describe(n, { refFor: (x) => this.ref(x), facts: this.facts, viewports: this.viewports() });
  }

  viewports() {
    const { docs } = this.obs;
    return { editor: docs.editor.viewport, ...(docs.preview ? { preview: docs.preview.viewport } : {}) };
  }
}

/** The binding a ref names, checked against an observation: the node it names now, or STALE_REF. */
async function checkRef(env: ObserveEnv, ref: string, obs: Observation, minter: Minter): Promise<{ binding: Binding; node: Shaped }> {
  const b = env.registry.get(ref);
  if (!b) throw stale('unknown', ref, `"${ref}" is not a ref this session gave out, or it is too old to remember.`);
  if (b.generation !== env.generation) throw stale('window', ref, `"${ref}" was seen in editor window ${b.generation}, not this one (${env.generation}).`);
  if (b.opening !== obs.docs.editor.opening) throw stale('project', ref, `"${ref}" was seen in another project, or another opening of this one.`);
  if (b.scope === 'preview') {
    if (obs.previewState !== 'ready' || !obs.docs.preview || !obs.preview)
      throw stale('loading', ref, `The preview is ${obs.previewState === 'absent' ? 'not shown' : 'still loading'}; "${ref}" cannot be checked until it is ready.`);
    if (obs.docs.preview.token !== b.doc) throw stale('document', ref, `"${ref}" was seen on a page the preview has since reloaded or left.`);
  } else if (obs.docs.editor.token !== b.doc) throw stale('document', ref, `"${ref}" was seen before the editor reloaded.`);
  // Names are left out of these messages: a page can come to show a credential where a name was.
  const node = findByPwRef(b.scope === 'editor' ? obs.editor : obs.preview!, b.pwRef);
  if (!node) throw stale('gone', ref, `"${ref}" (a ${b.role}) is no longer there, or its role or name changed.`);
  if (node.role !== b.role || (node.name ?? '') !== b.name) throw stale('changed', ref, `"${ref}" (a ${b.role}) has changed its role or name.`);
  await minter.read([node]);
  const facts = minter.facts.get(node);
  if (!facts) throw stale('gone', ref, `"${ref}" (a ${b.role}) could not be read on the page.`);
  if ((facts.semantic ? JSON.stringify(facts.semantic) : null) !== b.semantic) throw stale('changed', ref, `"${ref}" now shows another part of the page than it did.`);
  return { binding: b, node };
}

function argRef(v: unknown, what: string): string {
  if (!looksLikeRef(v)) throw new DriverError('BAD_REQUEST', `"${what}" is a ref from an observation, such as "a1b2c3:12".`);
  return v;
}

function argScope(v: unknown): UiScope {
  if (v === undefined) return 'all';
  if (v !== 'editor' && v !== 'preview' && v !== 'all') throw new DriverError('BAD_REQUEST', '"scope" is "editor", "preview" or "all".');
  return v;
}

function argInt(v: unknown, what: string, min: number, max: number): number | undefined {
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw new DriverError('BAD_REQUEST', `"${what}" is a whole number from ${min} to ${max}.`);
  return v as number;
}

function known(args: Record<string, unknown>, op: string, keys: string[]) {
  for (const key of Object.keys(args)) if (!keys.includes(key)) throw new DriverError('BAD_REQUEST', `${op} does not take "${key}".`);
}

// ---------------------------------------------------------------------------
// ui.snapshot
// ---------------------------------------------------------------------------

export function parseSnapshotArgs(a: Record<string, unknown> = {}): SnapshotArgs {
  known(a, 'ui.snapshot', ['scope', 'within', 'after', 'offset', 'maxNodes', 'depth', 'screenshot']);
  const out: SnapshotArgs = { scope: argScope(a.scope) };
  if (a.within !== undefined) out.within = argRef(a.within, 'within');
  if (a.scope !== undefined && a.within !== undefined) throw new DriverError('BAD_REQUEST', '"within" observes inside its ref\'s own scope: leave "scope" out.');
  if (a.after !== undefined) out.after = argRef(a.after, 'after');
  out.offset = argInt(a.offset, 'offset', 0, 1_000_000);
  // A continuation is inside a ref, or at the top of one scope.
  if ((out.offset !== undefined || out.after) && !out.within && out.scope === 'all') throw new DriverError('BAD_REQUEST', '"after" and "offset" continue inside a ref ("within") or one scope ("scope": "editor" or "preview").');
  out.maxNodes = argInt(a.maxNodes, 'maxNodes', 1, LIMITS.maxNodes);
  out.depth = argInt(a.depth, 'depth', 0, LIMITS.maxDepth);
  if (a.screenshot !== undefined && typeof a.screenshot !== 'boolean') throw new DriverError('BAD_REQUEST', '"screenshot" is true or false.');
  if (a.screenshot) out.screenshot = true;
  return out;
}

export interface SelectionContext {
  /** Whether the selection has a place on the page the canvas shows. */
  shown: boolean;
  /** Whether the canvas draws its outline now (it does not while Site styles is open, or in Preview). */
  outlined: boolean;
  /** The selection as the editor holds it: owner, components entered, node, part and repeated item. */
  element?: unknown;
  /** The page's element ids for where it shows. */
  semantic?: Semantic;
  /** The canvas toolbar that acts on it ("Split hero actions"), when it is drawn. */
  toolbar?: string;
  /** The preview's elements that show it (a repeated part shows several; one with no role of its own, none). */
  refs?: string[];
}

export interface UiContext {
  screen: 'welcome' | 'editor' | 'other';
  title: string;
  /** The editor's mode: `edit`, or `preview` (the site as visitors see it); null where there is none (Welcome). */
  mode: 'edit' | 'preview' | null;
  /** The topmost open dialog: the editor's, else one the site opened in the preview. */
  dialog: { scope: Scope; role: string; name?: string; ref?: string } | null;
  /** What has the keyboard focus: in the preview when the editor's focus is in its frame. */
  focus: { scope: Scope; role: string; name?: string; ref?: string } | null;
  preview: { state: PreviewState; path: string | null; editing: boolean | null };
  selection: SelectionContext | null;
}

export interface ScopeTree {
  nodes: UiNode[];
  /** Nodes in the whole scope (or under `within`), and how many of them are shown. */
  total: number;
  shown: number;
  /** Top-level nodes left out, and how to continue with them. */
  more?: { children: number; nodes: number; continue: Continuation };
}

export interface SnapshotResult {
  /** Counts observations in this session. */
  id: number;
  context: UiContext;
  editor?: ScopeTree;
  preview?: ScopeTree & { state: PreviewState; refs: boolean };
  /** With `within`: the node observed inside, and its scope. */
  within?: { ref: string; scope: Scope; node: UiNode };
  screenshots?: Shots;
}

export interface Shots {
  editor: Shot | null;
  preview: Shot | null;
  withheld?: string;
  /**
   * The token actions name to aim at a pixel of these images (a PointTarget's `observation`): given while nothing moved
   * as they were taken, and good until another screenshot, an action that sends input, or a minute passes.
   */
  observation?: string;
}

export interface Shot {
  path: string;
  /** In CSS pixels, as the image's own pixels are (one image pixel is one CSS pixel of the window). */
  width: number;
  height: number;
  /** Where the preview sits in the editor window, for the preview's shot. */
  clip?: { x: number; y: number; width: number; height: number };
  /**
   * For the preview's shot: where the page's own (0, 0) is in the editor window, and how far the canvas scales it, so
   * a box the preview reports (UiNode.box) is at `origin - clip + box * scale` on this image.
   */
  origin?: XY;
  scale?: number;
}

/** The CSS selector for a page's element ids, as the bridge finds them. */
export function semanticSelector(s: Semantic): string {
  const q = (v: string) => `"${v.replace(/[\\"]/g, '\\$&').replace(/\n/g, '\\a ')}"`;
  return `[data-so-ctx=${q(s.ctx)}][data-so-node=${q(s.node)}]${s.items ? `[data-so-items=${q(s.items)}]` : ''}`;
}

function parseSelection(attr: string | null): Semantic | null | undefined {
  if (attr === null) return undefined;
  if (!attr) return null;
  try {
    const d = JSON.parse(attr) as { ctx?: unknown; node?: unknown; items?: unknown };
    if (typeof d.ctx !== 'string' || typeof d.node !== 'string') return null;
    return { ctx: d.ctx, node: d.node, ...(typeof d.items === 'string' && d.items ? { items: d.items } : {}) };
  } catch {
    return null;
  }
}

const json = (v: unknown) => JSON.stringify(v ?? null);

function parseJson(attr: string | null): unknown {
  if (!attr) return undefined;
  try {
    return JSON.parse(attr);
  } catch {
    return undefined;
  }
}

/**
 * Playwright's ref for each element a locator matches, read by a snapshot of that element alone and checked to be the
 * element itself (a snapshot of an element the accessibility tree leaves out starts at its children). Each one
 * replaces its frame's last snapshot, so it runs only before an observation's full one.
 */
async function refsOf(page: Page, locator: Locator, limit: number, signal: AbortSignal): Promise<string[]> {
  const n = Math.min(await locator.count().catch(() => 0), limit);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    aborted(signal);
    const item = locator.nth(i);
    const json = (await item.ariaSnapshotJSON({ mode: 'ai', depth: 1, timeout: 2000, signal }).catch(() => null)) as RawNode[] | null;
    const ref = json?.[0] && typeof json[0] === 'object' ? json[0].ref : undefined;
    if (!ref) continue;
    const [a, b] = await Promise.all([item.elementHandle({ timeout: 1000 }).catch(() => null), page.locator(`aria-ref=${ref}`).elementHandle({ timeout: 1000 }).catch(() => null)]);
    const same = a && b ? await a.evaluate((x: Dom, y: Dom) => x === y, b).catch(() => false) : false;
    await Promise.all([a?.dispose(), b?.dispose()].map((d) => d?.catch(() => undefined)));
    if (same) out.push(ref);
  }
  return out;
}

/** Where a continuation resumes among `siblings`: after the node `after` names, else at `offset`. */
async function resumeAt(env: ObserveEnv, obs: Observation, minter: Minter, siblings: Shaped[], args: SnapshotArgs): Promise<number> {
  if (!args.after) return args.offset ?? 0;
  const { node } = await checkRef(env, args.after, obs, minter);
  const at = siblings.indexOf(node);
  if (at < 0) throw stale('gone', args.after, `"${args.after}" is no longer where the continuation left off.`);
  return at + 1;
}

export function uiSnapshot(env: ObserveEnv, args: SnapshotArgs, id: number): Promise<SnapshotResult> {
  return sealed((seen) => snapshotOf(env, args, id, seen));
}

async function snapshotOf(env: ObserveEnv, args: SnapshotArgs, id: number, seen: string[]): Promise<SnapshotResult> {
  let selectionRefs: string[] = [];
  let looked: string | null = null;
  const obs = await observeInto(env, seen, async (docs) => {
    const selected = parseSelection(docs.editor.selection);
    looked = docs.editor.selection;
    if (selected && docs.preview?.bridge) selectionRefs = await refsOf(env.page, docs.preview.frame.locator(semanticSelector(selected)), 5, env.signal);
  });
  // A selection that changed while it was looked up is reported as it is now, without elements to stand for it.
  if (obs.docs.editor.selection !== looked) selectionRefs = [];
  const selected = parseSelection(obs.docs.editor.selection);
  const minter = new Minter(env, obs);
  const max = args.maxNodes ?? LIMITS.defaultNodes;
  const result: SnapshotResult = { id, context: null as unknown as UiContext };

  // What to show.
  // Each tree's roots, and where they start among their siblings (for a continuation of a continuation).
  const trees: { scope: Scope; roots: Shaped[]; budget: number; from: number }[] = [];
  if (args.within) {
    const { binding, node } = await checkRef(env, args.within, obs, minter);
    const from = await resumeAt(env, obs, minter, node.children, args);
    trees.push({ scope: binding.scope, roots: node.children.slice(from), budget: max, from });
    result.within = { ref: args.within, scope: binding.scope, node: minter.describe(node) };
  } else if (args.after || args.offset !== undefined) {
    const scope = args.scope as Scope;
    const roots = scope === 'editor' ? obs.editor : obs.preview;
    if (!roots) throw new DriverError('TARGET_NOT_FOUND', 'The preview has no page to continue in.', { details: { preview: obs.previewState, hint: REFRESH_HINT } });
    const from = await resumeAt(env, obs, minter, roots, args);
    trees.push({ scope, roots: roots.slice(from), budget: max, from });
  } else {
    const wantEditor = args.scope !== 'preview';
    const wantPreview = args.scope !== 'editor' && !!obs.preview;
    if (wantEditor) trees.push({ scope: 'editor', roots: obs.editor, budget: wantPreview ? Math.ceil(max / 2) : max, from: 0 });
    if (wantPreview) trees.push({ scope: 'preview', roots: obs.preview!, budget: max, from: 0 });
  }
  const chosen = new Map<Scope, Set<Shaped>>();
  let used = 0;
  for (const t of trees) {
    const shown = choose(t.roots, { maxNodes: Math.max(0, Math.min(t.budget, max - used)), depth: args.depth });
    used += shown.size;
    chosen.set(t.scope, shown);
  }
  // What one scope left of its share goes to the other.
  const first = trees[0];
  if (trees.length > 1 && used < max && chosen.get(first.scope)!.size >= first.budget) {
    const more = choose(first.roots, { maxNodes: first.budget + (max - used), depth: args.depth });
    used += more.size - chosen.get(first.scope)!.size;
    chosen.set(first.scope, more);
  }

  // The context, from the whole tree.
  const dialog = dialogFrom(obs.editor) ?? (obs.preview && obs.previewState === 'ready' ? dialogFrom(obs.preview) : null);
  let focus = focusFrom(obs.editor);
  if (focus && focus === obs.previewIframe) focus = obs.preview ? focusFrom(obs.preview) : null;
  const toolbar = selectionToolbar(obs.editor);
  const showing = obs.preview ? selectionRefs.map((r) => findByPwRef(obs.preview!, r)).filter((n): n is Shaped => !!n) : [];
  const extra = [dialog, focus, ...showing].filter((n): n is Shaped => !!n);
  await minter.read([...[...chosen.values()].flatMap((s) => [...s]), ...extra]);
  // Only elements that still show the selection stand for it.
  const selectedNodes = showing.filter((n) => selected && json(minter.facts.get(n)?.semantic) === json(selected));

  const brief = (n: Shaped | null) => {
    if (!n) return null;
    const ref = minter.ref(n);
    return { scope: n.scope, role: n.role, ...(n.name ? { name: n.name } : {}), ...(ref ? { ref } : {}) };
  };
  const preview = obs.docs.preview;
  const element = parseJson(obs.docs.editor.selected);
  result.context = {
    screen: obs.docs.editor.screen,
    title: obs.docs.editor.title,
    mode: obs.docs.editor.mode,
    dialog: brief(dialog),
    focus: brief(focus),
    preview: { state: obs.previewState, path: preview?.path ?? null, editing: preview ? preview.editing : null },
    selection:
      selected === undefined
        ? null
        : {
            shown: !!selected,
            outlined: obs.docs.editor.outlined,
            ...(element !== undefined ? { element } : {}),
            ...(selected ? { semantic: selected } : {}),
            ...(toolbar?.name ? { toolbar: toolbar.name } : {}),
            ...(selected ? { refs: selectedNodes.map((n) => minter.ref(n)).filter((r): r is string => !!r) } : {})
          }
  };

  for (const t of trees) {
    const shown = chosen.get(t.scope)!;
    const nodes = render(t.roots, { shown, refFor: (n) => minter.ref(n), facts: minter.facts, viewports: minter.viewports() });
    const tree: ScopeTree = { nodes, total: t.roots.reduce((s, n) => s + 1 + n.size, 0), shown: shown.size };
    const left = rootsLeft(t.roots, shown);
    if (left) {
      const after = nodes[nodes.length - 1]?.ref;
      const base = args.within ? { within: args.within } : { scope: t.scope };
      tree.more = { ...left, continue: { ...base, ...(after ? { after } : {}), offset: t.from + t.roots.length - left.children } };
    }
    if (t.scope === 'editor') result.editor = tree;
    else result.preview = { ...tree, state: obs.previewState, refs: obs.previewState === 'ready' };
  }

  if (args.screenshot) result.screenshots = await screenshots(env, obs, id);
  aborted(env.signal);
  return result;
}

async function screenshots(env: ObserveEnv, obs: Observation, id: number): Promise<Shots> {
  const { page, signal } = env;
  if (!env.artifacts) throw new DriverError('OP_FAILED', 'This session has no artifacts folder to save screenshots in.');
  // Any screenshot replaces the last one's points, whether or not this one gives any.
  const token = env.shots?.next() ?? null;
  // Pixels cannot be scrubbed, and a credential can be painted where no text check finds it: nothing is captured while
  // the session knows any credential (a filled credential field, a saved key, one seen before), or cannot tell.
  const withheld = { editor: null, preview: null, withheld: 'A credential is known in this session, and screenshots could show it.' };
  // Anything that cannot be read counts as a credential.
  const clear = async () => {
    const known = await Promise.all([frameSecrets(page, { strict: true }), env.storedSecrets?.(true) ?? Promise.resolve([])]).catch(() => null);
    return !!known && !known.flat().length && !env.remembered?.().length;
  };
  if (obs.secrets.length || obs.echoes || !(await clear())) return withheld;
  const dir = join(env.artifacts, 'snapshots');
  const mask = page.frames().map((f) => f.locator(SECRET_INPUTS));
  const vp = await page.evaluate(() => ({ width: (globalThis as Dom).innerWidth as number, height: (globalThis as Dom).innerHeight as number }));
  // The scene before the pixels, with every element's box as the witness of what each pixel showed; compared after.
  const frame = obs.docs.preview?.frame ?? null;
  const before: Scene | null = token ? await readScene(page, frame, PREVIEW_IFRAME, token).catch(() => null) : null;
  const editorPng = await page.screenshot({ mask, timeout: 10_000, scale: 'css' });
  aborted(signal);
  // The preview as it shows in the editor (zoomed, with the canvas's outlines over it), clipped to what is in view.
  const box = await page
    .locator(PREVIEW_IFRAME)
    .boundingBox({ timeout: 1000 })
    .catch(() => null);
  let clip: Shot['clip'] | null = null;
  if (box) {
    const x = Math.max(0, box.x);
    const y = Math.max(0, box.y);
    const width = Math.min(vp.width, box.x + box.width) - x;
    const height = Math.min(vp.height, box.y + box.height) - y;
    if (width >= 1 && height >= 1) clip = { x: Math.floor(x), y: Math.floor(y), width: Math.floor(width), height: Math.floor(height) };
  }
  const previewPng = clip ? await page.screenshot({ mask, clip, timeout: 10_000, scale: 'css' }) : null;
  const after: Scene | null = before ? await readScene(page, frame, PREVIEW_IFRAME).catch(() => null) : null;
  // A credential typed or saved while the pixels were taken counts as well.
  if (!(await clear())) return withheld;
  // A capture that outlived its request leaves nothing behind.
  aborted(signal);
  await mkdir(dir, { recursive: true });
  const stem = join(dir, String(id).padStart(4, '0'));
  const written: string[] = [];
  try {
    aborted(signal);
    written.push(`${stem}-editor.png`);
    await writeFile(`${stem}-editor.png`, editorPng);
    if (previewPng) {
      aborted(signal);
      written.push(`${stem}-preview.png`);
      await writeFile(`${stem}-preview.png`, previewPng);
    }
    aborted(signal);
  } catch (e) {
    await Promise.all(written.map((f) => rm(f, { force: true }).catch(() => undefined)));
    throw e;
  }
  // Where the page sits on the preview image, only from a capture nothing moved during.
  const still = !!before && !!after && !sceneChange(before, after);
  const f = still ? after!.frame : null;
  const out: Shots = {
    editor: { path: `${stem}-editor.png`, width: vp.width, height: vp.height },
    preview: previewPng && clip ? { path: `${stem}-preview.png`, width: clip.width, height: clip.height, clip, ...(f ? { origin: f.origin, scale: f.scale.x } : {}) } : null
  };
  // Points on the images stand for what they show only if nothing moved while they were taken.
  if (token && env.shots && still && after!.editor.viewport.width === vp.width && after!.editor.viewport.height === vp.height) {
    env.shots.issue({ token, at: performance.now(), generation: env.generation, scene: after!, editor: { width: vp.width, height: vp.height }, preview: out.preview?.clip ? { clip: out.preview.clip } : null });
    out.observation = token;
  }
  return out;
}

// ---------------------------------------------------------------------------
// ui.locate
// ---------------------------------------------------------------------------

export function parseLocateArgs(a: Record<string, unknown> = {}): LocateArgs {
  known(a, 'ui.locate', ['ref', 'role', 'name', 'exact', 'region', 'within', 'scope']);
  if (a.ref !== undefined) {
    if (Object.keys(a).length > 1) throw new DriverError('BAD_REQUEST', 'ui.locate takes a "ref" alone, or a "role" to find.');
    return { ref: argRef(a.ref, 'ref') };
  }
  if (typeof a.role !== 'string' || !/^[a-z]+$/.test(a.role)) throw new DriverError('BAD_REQUEST', 'ui.locate needs a "ref", or an ARIA "role" (such as "button") to find.');
  const out: LocateArgs = { role: a.role, scope: argScope(a.scope) };
  if (a.name !== undefined) {
    if (typeof a.name !== 'string' || !a.name.trim()) throw new DriverError('BAD_REQUEST', '"name" is a non-empty string.');
    out.name = a.name;
  }
  if (a.exact !== undefined) {
    if (typeof a.exact !== 'boolean') throw new DriverError('BAD_REQUEST', '"exact" is true or false.');
    out.exact = a.exact;
  }
  if (a.region !== undefined) {
    if (typeof a.region !== 'string' || !a.region.trim()) throw new DriverError('BAD_REQUEST', '"region" is a region\'s role, name or `role "name"`.');
    out.region = a.region;
  }
  if (a.within !== undefined) out.within = argRef(a.within, 'within');
  if (out.within && out.region) throw new DriverError('BAD_REQUEST', 'Give "within" or "region", not both.');
  if (out.within && a.scope !== undefined) throw new DriverError('BAD_REQUEST', '"within" searches inside its ref\'s own scope: leave "scope" out.');
  return out;
}

export interface Located {
  scope: Scope;
  /** The regions it sits in, outermost first. */
  region: string[];
  node: UiNode;
}

/** The most elements of one role and name one search places in a scope; past this it says so. */
const MATCH_LIMIT = 10_000;
/** The most observed nodes of one role a search places its matches among; past this it says so. */
const CANDIDATE_LIMIT = 10_000;

export function uiLocate(env: ObserveEnv, args: LocateArgs): Promise<Located> {
  return sealed((seen) => locateIn(env, args, seen));
}

async function locateIn(env: ObserveEnv, args: LocateArgs, seen: string[]): Promise<Located> {
  const obs = await observeInto(env, seen);
  const minter = new Minter(env, obs);
  if (args.ref) {
    const { node } = await checkRef(env, args.ref, obs, minter);
    return located(node, minter, args);
  }
  // Found through Playwright's own role matching (what acting by role and name uses), and placed in the observation
  // by element identity: an accessibility snapshot leaves out a name a child repeats, so its names are not matched.
  // The whole scope is searched and the matches are kept by where the observation places them, so a region or a ref
  // contains what the outline shows inside it (an aria-owns child included), not what the DOM nests in it.
  let scopes: Scope[] = args.scope === 'editor' ? ['editor'] : args.scope === 'preview' ? ['preview'] : ['editor', 'preview'];
  let inside: Set<Shaped> | null = null;
  if (args.within) {
    const { binding, node } = await checkRef(env, args.within, obs, minter);
    scopes = [binding.scope];
    inside = new Set(walk(node.children));
  }
  const query = { role: args.role, ...(args.name !== undefined ? { name: args.name } : {}), ...(args.exact === false ? { exact: false } : {}), ...(args.region ? { region: args.region } : {}), ...(args.within ? { within: args.within } : {}), scope: args.scope ?? 'all' };
  const searchable = scopes.filter((scope) => {
    if (scope === 'editor') return true;
    if (obs.previewState === 'ready' && obs.docs.preview && obs.preview) return true;
    if (args.scope === 'preview' || args.within)
      throw new DriverError('TARGET_NOT_FOUND', `The preview is ${obs.previewState === 'absent' ? 'not shown' : 'still loading'}: nothing in it can be found yet.`, {
        details: { query, preview: obs.previewState, hint: 'Wait for context.preview.state to be "ready" (ui.snapshot), then locate again.' }
      });
    return false;
  });
  if (args.region && !searchable.some((scope) => regionNodes(scope === 'editor' ? obs.editor : obs.preview!, args.region!).length))
    throw new DriverError('TARGET_NOT_FOUND', `There is no region "${args.region}" to search.`, { details: { query, preview: obs.previewState, hint: 'Take a ui.snapshot to see the regions there are.' } });
  const all = await matchesIn(env, obs, searchable, args);
  aborted(env.signal);
  if (all === 'too-many') throw new DriverError('OP_FAILED', `More than ${MATCH_LIMIT} elements in one scope are ${args.role}s: too many to place.`, { details: { query, hint: 'Take a ui.snapshot and drill in with "within" instead.' } });
  if (all === 'incomplete') throw new DriverError('OP_FAILED', 'Not every match could be placed in the observation (the page changed, or a match is outside the accessibility tree); locate again.', { retryable: true, details: { query, hint: REFRESH_HINT } });
  const found = all.filter((n) => (!args.region || regionMatches(n.regions, args.region)) && (!inside || inside.has(n)));
  if (!found.length) throw new DriverError('TARGET_NOT_FOUND', `Nothing is ${args.role}${args.name ? ` "${args.name}"` : ''}${args.region ? ` in "${args.region}"` : ''}${args.within ? ' within that ref' : ''}.`, { details: { query, preview: obs.previewState, hint: 'Take a ui.snapshot to see what there is.' } });
  if (found.length > 1) {
    const shown = found.slice(0, LIMITS.candidates);
    await minter.read(shown);
    const candidates = shown.map((n) => {
      const ref = minter.ref(n);
      return { ...(ref ? { ref } : {}), scope: n.scope, role: n.role, ...(n.name ? { name: n.name } : args.name && args.exact !== false ? { name: args.name } : {}), region: n.regions };
    });
    throw new DriverError('AMBIGUOUS_TARGET', `${found.length} elements are ${args.role}${args.name ? ` "${args.name}"` : ''}: tell them apart by region, or use a ref.`, {
      details: { count: found.length, candidates, query, hint: 'Locate again with "region" set to one of the candidates\' regions, or use a candidate\'s ref.' }
    });
  }
  return located(found[0], minter, args);
}

/**
 * Every observed node Playwright's role matching finds in the scopes, in order. Each match is held as a handle and
 * paired with the observed nodes of that role by identity in the page, all while the observation's snapshot is still
 * each frame's last one (which `aria-ref` resolves against). A match that cannot be placed makes the search
 * incomplete: it never reports a unique match, or none, without having placed every one.
 */
async function matchesIn(env: ObserveEnv, obs: Observation, scopes: Scope[], args: LocateArgs): Promise<Shaped[] | 'too-many' | 'incomplete'> {
  const held: ElementHandle[] = [];
  try {
    const out: Shaped[] = [];
    for (const scope of scopes) {
      const base: Page | Frame = scope === 'editor' ? env.page : obs.docs.preview!.frame;
      const tree = scope === 'editor' ? obs.editor : obs.preview!;
      const loc = base.getByRole(args.role as Parameters<Page['getByRole']>[0], args.name !== undefined ? { name: args.name, exact: args.exact !== false } : {});
      // Counted first, so a huge page is refused before Playwright makes a handle for every match.
      if ((await loc.count().catch(() => 0)) > MATCH_LIMIT) return 'too-many';
      // Every match in one query: elements that move between reads cannot be counted twice or missed.
      const matches = (await loc.elementHandles().catch(() => null)) as ElementHandle[] | null;
      if (!matches) return 'incomplete';
      held.push(...matches);
      if (matches.length > MATCH_LIMIT) return 'too-many';
      if (!matches.length) continue;
      const nodes = [...walk(tree)].filter((x) => x.pwRef && x.role === args.role);
      if (nodes.length > CANDIDATE_LIMIT) return 'too-many';
      const handles = await Promise.all(
        nodes.map(async (x) => {
          const l = env.page.locator(`aria-ref=${x.pwRef}`);
          if ((await l.count().catch(() => 0)) !== 1) return null;
          return (await l.elementHandle({ timeout: 1000 }).catch(() => null)) as ElementHandle | null;
        })
      );
      for (const h of handles) if (h) held.push(h);
      const present = handles.map((h, i) => (h ? i : -1)).filter((i) => i >= 0);
      const list = present.map((i) => handles[i]!);
      // Every match placed in one call in the page, by identity.
      const at = (await base.evaluate(([ms, all]: [Dom[], Dom[]]) => ms.map((m) => all.indexOf(m)), [matches, list] as [ElementHandle[], ElementHandle[]]).catch(() => null)) as number[] | null;
      if (!at || at.some((i) => i < 0)) return 'incomplete';
      for (const i of at) {
        const node = nodes[present[i]];
        if (out.includes(node)) return 'incomplete';
        out.push(node);
      }
    }
    return out;
  } finally {
    await Promise.all(held.map((h) => h.dispose().catch(() => undefined)));
  }
}

async function located(node: Shaped, minter: Minter, args: LocateArgs): Promise<Located> {
  await minter.read([node]);
  const out = minter.describe(node);
  if (!out.ref) throw new DriverError('OP_FAILED', 'The element was found but could not be read on the page; locate again.', { retryable: true, details: { hint: REFRESH_HINT } });
  // An accessibility snapshot leaves out a name a child repeats; the match itself had it.
  if (!out.name && args.name !== undefined && args.exact !== false) out.name = args.name;
  if (node.children.length && out.ref) out.more = { children: node.children.length, nodes: node.size, continue: { within: out.ref, offset: 0 } };
  return { scope: node.scope, region: node.regions, node: out };
}

// ---------------------------------------------------------------------------
// The element a ref names, for acting on (issue #493)
// ---------------------------------------------------------------------------

/** One target an action names, resolved: its exact element, held. */
export interface Resolved {
  ref: string;
  handle: ElementHandle;
  scope: Scope;
  role: string;
  name: string;
}

export interface Resolution {
  targets: Resolved[];
  /** The editor's mode when they were resolved. */
  mode: 'edit' | 'preview' | null;
  /** The topmost dialog's name, for saying what covers a target. */
  dialog: string | null;
}

/**
 * The elements refs name, all from one observation: each checked as `ui.locate` checks a ref, then checked again on
 * the element itself (its document, its page ids, the project open around it). A handle belongs to one document, so
 * acting through it can never reach an element of a page that replaced it. The caller disposes of the handles.
 */
export async function resolveInto(env: ObserveEnv, seen: string[], refs: string[]): Promise<Resolution> {
  for (const ref of refs) argRef(ref, 'ref');
  const obs = await observeInto(env, seen);
  const minter = new Minter(env, obs);
  const targets: Resolved[] = [];
  try {
    for (const ref of refs) {
      const known = targets.find((t) => t.ref === ref);
      if (known) continue;
      const { binding } = await checkRef(env, ref, obs, minter);
      const handle = (await env.page
        .locator(`aria-ref=${binding.pwRef}`)
        .elementHandle({ timeout: 2000 })
        .catch(() => null)) as ElementHandle | null;
      if (!handle) throw stale('gone', ref, `"${ref}" is no longer there.`);
      targets.push({ ref, handle, scope: binding.scope, role: binding.role, name: binding.name });
      // Evaluated in the element's own document, which a reload or another page replaces.
      const now = (await handle.evaluate((el: Dom) => (el.isConnected ? { doc: `${(globalThis as Dom).performance.timeOrigin}|${(globalThis as Dom).location.pathname}${(globalThis as Dom).location.search}`, node: el.getAttribute('data-so-node'), ctx: el.getAttribute('data-so-ctx'), items: el.getAttribute('data-so-items') } : null)).catch(() => null)) as {
        doc: string;
        node: string | null;
        ctx: string | null;
        items: string | null;
      } | null;
      if (!now || now.doc !== binding.doc) throw stale('document', ref, `"${ref}" was seen on a page that has since been replaced.`);
      const semantic = now.node !== null ? JSON.stringify({ ctx: now.ctx ?? '', node: now.node, ...(now.items ? { items: now.items } : {}) }) : null;
      if (semantic !== binding.semantic) throw stale('changed', ref, `"${ref}" now shows another part of the page than it did.`);
    }
    if (targets.length && (await readEditor(env.page)).opening !== obs.docs.editor.opening) throw stale('project', refs[0], `"${refs[0]}" was seen in another project, or another opening of this one.`);
    const dialog = dialogFrom(obs.editor) ?? (obs.preview && obs.previewState === 'ready' ? dialogFrom(obs.preview) : null);
    return { targets, mode: obs.docs.editor.mode, dialog: dialog?.name ?? null };
  } catch (e) {
    await Promise.all(targets.map((t) => t.handle.dispose().catch(() => undefined)));
    throw e;
  }
}

/**
 * The element a ref names, for acting on it in-process: as resolveInto resolves it. The caller disposes of it.
 */
export function elementFor(env: ObserveEnv, ref: string): Promise<ElementHandle> {
  return sealed(async (seen) => (await resolveInto(env, seen, [ref])).targets[0].handle, { result: false });
}

/** Every node a tree shows, depth first. */
export function flatten(nodes: UiNode[]): UiNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children ?? [])]);
}
