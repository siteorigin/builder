/**
 * UI observations for the test driver (issue #492): the half that reads the app. One observation reads both documents'
 * state (the editor's, and the preview's when there is one), takes Playwright's accessibility snapshot of the editor's
 * whole page (it enters the preview's iframe), reads both documents again, and redacts the raw tree before shaping it
 * (snapshot.ts). Refs are minted only from an observation whose documents did not change while it was taken, and,
 * for the preview, only once its page is hydrated and the canvas calls it ready.
 *
 * Every lookup goes through a full snapshot because Playwright resolves its `aria-ref` selector against each frame's
 * last snapshot: observing everything each time keeps every element's ref resolvable, and Playwright keeps an
 * element's ref while its role and name stay the same, so the session's refs stay the same too.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ElementHandle, Frame, Locator, Page } from 'playwright';
import { DriverError } from './protocol.ts';
import type { LocateArgs, SnapshotArgs, UiScope } from './protocol.ts';
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
  modeFrom,
  redact,
  regionNodes,
  render,
  rootsLeft,
  selectionToolbar,
  shape,
  valueRefs
} from './snapshot.ts';
import type { Binding, ElementFacts, RawNode, Scope, Semantic, Shaped, StaleReason, UiNode } from './snapshot.ts';

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
}

/** The canvas's iframe: the live preview. */
const PREVIEW_IFRAME = '.frame-box iframe';
/** Fields whose values are credentials, in any document. */
const SECRET_INPUTS = 'input[type="password" i], input[autocomplete*="password" i]';

interface EditorDoc {
  token: string;
  screen: 'welcome' | 'editor' | 'other';
  title: string;
  opening: string;
  /** The canvas's frame state, or null without a canvas. */
  frame: 'ready' | 'loading' | null;
  /** The canvas's selection attribute: null for none, '' for one not on this page, else its element ids as JSON. */
  selection: string | null;
  secrets: string[];
  viewport: { width: number; height: number };
}

interface PreviewDoc {
  frame: Frame;
  token: string;
  path: string;
  /** The bridge has loaded in this document (it loads once the page is hydrated). */
  bridge: boolean;
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
  editor: Shaped[];
  /** The preview's tree, or null when there is none. */
  preview: Shaped[] | null;
  previewState: PreviewState;
  /** The preview iframe's node in the editor tree. */
  previewIframe: Shaped | null;
}

async function readEditor(page: Page): Promise<EditorDoc> {
  return page.evaluate(
    (secret): EditorDoc => {
      const w = globalThis as Dom;
      const canvas = w.document.querySelector('main.canvas');
      const frame = canvas?.getAttribute('data-frame');
      return {
        // What tells this document apart from every other the window has shown (the same in every read below).
        token: `${w.performance.timeOrigin}|${w.location.pathname}`,
        screen: w.document.querySelector('.editor') ? 'editor' : w.document.querySelector('.welcome') ? 'welcome' : 'other',
        title: w.document.title,
        opening: canvas?.getAttribute('data-opening') ?? '',
        frame: frame === 'ready' || frame === 'loading' ? frame : null,
        selection: canvas ? canvas.getAttribute('data-selection') : null,
        secrets: [...w.document.querySelectorAll(secret)].map((i: Dom) => String(i.value)).filter((v: string) => !!v),
        viewport: { width: w.innerWidth, height: w.innerHeight }
      };
    },
    SECRET_INPUTS
  );
}

async function readPreview(page: Page): Promise<{ iframe: boolean; doc: PreviewDoc | null }> {
  const el = await page.$(PREVIEW_IFRAME).catch(() => null);
  if (!el) return { iframe: false, doc: null };
  try {
    const frame = await el.contentFrame();
    if (!frame) return { iframe: true, doc: null };
    const read = await frame.evaluate(
      (secret) => {
        const w = globalThis as Dom;
        const html = w.document.documentElement;
        return {
          // A reload, or a page the site went to without one, is another document.
          token: `${w.performance.timeOrigin}|${w.location.pathname}` as string,
          path: w.location.pathname as string,
          bridge: html.hasAttribute('data-so-bridge') as boolean,
          editing: html.hasAttribute('data-so-editing') as boolean,
          secrets: [...w.document.querySelectorAll(secret)].map((i: Dom) => String(i.value)).filter((v: string) => !!v),
          viewport: { width: w.innerWidth as number, height: w.innerHeight as number }
        };
      },
      SECRET_INPUTS
    );
    return { iframe: true, doc: { frame, ...read } };
  } catch {
    // Between documents: the frame has no page to read yet.
    return { iframe: true, doc: null };
  } finally {
    await el.dispose().catch(() => undefined);
  }
}

async function readDocs(page: Page): Promise<Docs> {
  const [editor, preview] = await Promise.all([readEditor(page), readPreview(page)]);
  return { editor, preview: preview.doc, iframe: preview.iframe };
}

/** Runs in the element's own document (Playwright sends its source, so it uses nothing from outside). */
function factOf(el: Dom): ElementFacts {
  const auto = el.getAttribute('autocomplete') ?? '';
  const secret = el.tagName === 'INPUT' && (el.type === 'password' || /password/i.test(auto));
  const node = el.getAttribute('data-so-node');
  const items = el.getAttribute('data-so-items');
  return {
    secret,
    blocked: !!el.closest('[inert]'),
    semantic: node !== null ? { ctx: el.getAttribute('data-so-ctx') ?? '', node, ...(items ? { items } : {}) } : null
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
  const docs = await readDocs(page);
  if (docs.editor.token !== first.editor.token)
    throw new DriverError('OP_FAILED', 'The editor reloaded while it was observed; observe again.', { retryable: true, details: { hint: REFRESH_HINT } });
  // Which iframe is the preview: the one the canvas shows.
  const iframes = [...walkRaw(raw)].filter((n) => n.role === 'iframe' && n.ref);
  const isPreview = await Promise.all(iframes.map((n) => onRef(page, n.ref!, (el, sel: string) => !!el.matches(sel), PREVIEW_IFRAME)));
  const previewRaw = iframes.find((_, i) => isPreview[i]) ?? null;
  // Credentials leave nothing behind: values of secret fields, and of fields that could not be classified, go, and
  // so does every echo of a secret anywhere.
  const valued = valueRefs(raw);
  const classified = await factsByRef(page, valued);
  const secretRefs = new Set(valued.filter((r) => classified.get(r)?.secret));
  const unknownRefs = new Set(valued.filter((r) => !classified.get(r)));
  redact(raw, { secretRefs, unknownRefs, secrets: [...first.editor.secrets, ...docs.editor.secrets, ...(first.preview?.secrets ?? []), ...(docs.preview?.secrets ?? [])] });
  const editor = shape(raw, 'editor');
  // An iframe Playwright could not enter has no children: its page is not there to observe yet.
  const preview = previewRaw?.children?.length ? shape(previewRaw.children, 'preview') : null;
  const previewIframe = previewRaw?.ref ? findByPwRef(editor, previewRaw.ref) : null;
  let previewState: PreviewState = 'ready';
  if (!docs.iframe) previewState = 'absent';
  else if (!docs.preview || !first.preview || !docs.preview.bridge || docs.editor.frame !== 'ready' || first.preview.token !== docs.preview.token || !preview) previewState = 'loading';
  return { docs, editor, preview, previewState, previewIframe };
}

function* walkRaw(nodes: (RawNode | string)[] | undefined): Generator<RawNode> {
  for (const n of nodes ?? []) {
    if (typeof n === 'string') continue;
    yield n;
    // An iframe's children are another document; only the canvas's own iframes are looked at, at the top level.
    if (n.role !== 'iframe') yield* walkRaw(n.children);
  }
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
  constructor(env: ObserveEnv, obs: Observation) {
    this.env = env;
    this.obs = obs;
  }

  /** Read the facts of every node that may get a ref, or be described. */
  async read(nodes: Iterable<Shaped>) {
    const want = [...new Set(nodes)].filter((n) => n.pwRef && !this.facts.has(n));
    const facts = await factsByRef(this.env.page, want.map((n) => n.pwRef!));
    for (const n of want) {
      const f = facts.get(n.pwRef!);
      if (f) this.facts.set(n, f);
    }
  }

  /** The node's ref; null for one that may not have one (a preview that is not ready, or no Playwright ref). */
  ref(n: Shaped): string | null {
    if (!n.pwRef || this.env.signal.aborted) return null;
    const { docs, previewState } = this.obs;
    if (n.scope === 'preview' && (previewState !== 'ready' || !docs.preview)) return null;
    const semantic = this.facts.get(n)?.semantic;
    return this.env.registry.mint({
      generation: this.env.generation,
      scope: n.scope,
      opening: docs.editor.opening,
      doc: n.scope === 'editor' ? docs.editor.token : docs.preview!.token,
      pwRef: n.pwRef,
      role: n.role,
      name: n.name ?? '',
      semantic: semantic ? JSON.stringify(semantic) : null
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
  const node = findByPwRef(b.scope === 'editor' ? obs.editor : obs.preview!, b.pwRef);
  if (!node) throw stale('gone', ref, `"${ref}" (${b.role}${b.name ? ` "${b.name}"` : ''}) is no longer there, or its role or name changed.`);
  if (node.role !== b.role || (node.name ?? '') !== b.name) throw stale('changed', ref, `"${ref}" is now ${node.role}${node.name ? ` "${node.name}"` : ''}, not ${b.role}${b.name ? ` "${b.name}"` : ''}.`);
  await minter.read([node]);
  const semantic = minter.facts.get(node)?.semantic;
  if ((semantic ? JSON.stringify(semantic) : null) !== b.semantic) throw stale('changed', ref, `"${ref}" now shows another part of the page than it did.`);
  return { binding: b, node };
}

function argRef(v: unknown, what: string): string {
  if (!looksLikeRef(v)) throw new DriverError('BAD_REQUEST', `"${what}" is a ref from an observation, such as "a1b2:12".`);
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
  known(a, 'ui.snapshot', ['scope', 'within', 'offset', 'maxNodes', 'depth', 'screenshot']);
  const out: SnapshotArgs = { scope: argScope(a.scope) };
  if (a.within !== undefined) out.within = argRef(a.within, 'within');
  if (a.scope !== undefined && a.within !== undefined) throw new DriverError('BAD_REQUEST', '"within" observes inside its ref\'s own scope: leave "scope" out.');
  out.offset = argInt(a.offset, 'offset', 0, 1_000_000);
  if (out.offset !== undefined && !out.within) throw new DriverError('BAD_REQUEST', '"offset" continues inside a ref: give "within" too.');
  out.maxNodes = argInt(a.maxNodes, 'maxNodes', 1, LIMITS.maxNodes);
  out.depth = argInt(a.depth, 'depth', 0, LIMITS.maxDepth);
  if (a.screenshot !== undefined && typeof a.screenshot !== 'boolean') throw new DriverError('BAD_REQUEST', '"screenshot" is true or false.');
  if (a.screenshot) out.screenshot = true;
  return out;
}

export interface SelectionContext {
  /** Whether the selection shows on the page in the canvas. */
  shown: boolean;
  /** The page's element ids for it. */
  semantic?: Semantic;
  /** The canvas toolbar that acts on it ("Split hero actions"), when it is drawn. */
  toolbar?: string;
  /** The preview's elements that show it (a repeated part shows several). */
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
  /** Top-level nodes left out: continue with a larger maxNodes, or observe a region `within` its ref. */
  more?: { children: number; nodes: number };
}

export interface SnapshotResult {
  /** Counts observations in this session. */
  id: number;
  context: UiContext;
  editor?: ScopeTree;
  preview?: ScopeTree & { state: PreviewState; refs: boolean };
  /** With `within`: the node observed inside, and its scope. */
  within?: { ref: string; scope: Scope; node: UiNode };
  screenshots?: { editor: Shot; preview: Shot | null };
}

export interface Shot {
  path: string;
  width: number;
  height: number;
  /** Where the preview sits in the editor window, for the preview's shot. */
  clip?: { x: number; y: number; width: number; height: number };
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

/**
 * Playwright's ref for each element a locator matches, read by a snapshot of that element alone and checked to be the
 * element itself (a snapshot of an element the accessibility tree leaves out starts at its children). Each one
 * replaces its frame's last snapshot, so `aria-ref` lookups wait for the next full one.
 */
async function refsOf(page: Page, locator: Locator, limit: number): Promise<string[]> {
  const n = Math.min(await locator.count().catch(() => 0), limit);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const item = locator.nth(i);
    const json = (await item.ariaSnapshotJSON({ mode: 'ai', depth: 1, timeout: 2000 }).catch(() => null)) as RawNode[] | null;
    const ref = json?.[0] && typeof json[0] === 'object' ? json[0].ref : undefined;
    if (!ref) continue;
    const [a, b] = await Promise.all([item.elementHandle({ timeout: 1000 }).catch(() => null), page.locator(`aria-ref=${ref}`).elementHandle({ timeout: 1000 }).catch(() => null)]);
    const same = a && b ? await a.evaluate((x: Dom, y: Dom) => x === y, b).catch(() => false) : false;
    await Promise.all([a?.dispose(), b?.dispose()].map((d) => d?.catch(() => undefined)));
    if (same) out.push(ref);
  }
  return out;
}

export async function uiSnapshot(env: ObserveEnv, args: SnapshotArgs, id: number): Promise<SnapshotResult> {
  let selectionRefs: string[] = [];
  let selected: Semantic | null | undefined;
  const obs = await observe(env, async (docs) => {
    selected = parseSelection(docs.editor.selection);
    if (selected && docs.preview?.bridge) selectionRefs = await refsOf(env.page, docs.preview.frame.locator(semanticSelector(selected)), 5);
  });
  const minter = new Minter(env, obs);
  const max = args.maxNodes ?? LIMITS.defaultNodes;
  const result: SnapshotResult = { id, context: null as unknown as UiContext };

  // What to show.
  const trees: { scope: Scope; roots: Shaped[]; budget: number }[] = [];
  if (args.within) {
    const { binding, node } = await checkRef(env, args.within, obs, minter);
    trees.push({ scope: binding.scope, roots: node.children.slice(args.offset ?? 0), budget: max });
    result.within = { ref: args.within, scope: binding.scope, node: minter.describe(node) };
  } else {
    const wantEditor = args.scope !== 'preview';
    const wantPreview = args.scope !== 'editor' && !!obs.preview;
    if (wantEditor) trees.push({ scope: 'editor', roots: obs.editor, budget: wantPreview ? Math.ceil(max / 2) : max });
    if (wantPreview) trees.push({ scope: 'preview', roots: obs.preview!, budget: max });
  }
  const chosen = new Map<Scope, Set<Shaped>>();
  let used = 0;
  for (const t of trees) {
    const shown = choose(t.roots, { maxNodes: Math.max(0, Math.min(t.budget, max - used)), depth: args.depth });
    used += shown.size;
    chosen.set(t.scope, shown);
  }

  // The context, from the whole tree.
  const dialog = dialogFrom(obs.editor) ?? (obs.preview && obs.previewState === 'ready' ? dialogFrom(obs.preview) : null);
  let focus = focusFrom(obs.editor);
  if (focus && focus === obs.previewIframe) focus = obs.preview ? focusFrom(obs.preview) : null;
  const toolbar = selectionToolbar(obs.editor);
  const selectedNodes = obs.preview ? selectionRefs.map((r) => findByPwRef(obs.preview!, r)).filter((n): n is Shaped => !!n) : [];
  const extra = [dialog, focus, ...selectedNodes].filter((n): n is Shaped => !!n);
  await minter.read([...[...chosen.values()].flatMap((s) => [...s]), ...extra]);

  const brief = (n: Shaped | null) => {
    if (!n) return null;
    const ref = minter.ref(n);
    return { scope: n.scope, role: n.role, ...(n.name ? { name: n.name } : {}), ...(ref ? { ref } : {}) };
  };
  const preview = obs.docs.preview;
  result.context = {
    screen: obs.docs.editor.screen,
    title: obs.docs.editor.title,
    mode: modeFrom(obs.editor),
    dialog: brief(dialog),
    focus: brief(focus),
    preview: { state: obs.previewState, path: preview?.path ?? null, editing: preview ? preview.editing : null },
    selection:
      selected === undefined
        ? null
        : selected === null
          ? { shown: false }
          : {
              shown: true,
              semantic: selected,
              ...(toolbar?.name ? { toolbar: toolbar.name } : {}),
              refs: selectedNodes.map((n) => minter.ref(n)).filter((r): r is string => !!r)
            }
  };

  for (const t of trees) {
    const shown = chosen.get(t.scope)!;
    const tree: ScopeTree = {
      nodes: render(t.roots, { shown, refFor: (n) => minter.ref(n), facts: minter.facts, viewports: minter.viewports() }),
      total: t.roots.reduce((s, n) => s + 1 + n.size, 0),
      shown: shown.size
    };
    const left = rootsLeft(t.roots, shown);
    if (left) tree.more = left;
    if (t.scope === 'editor') result.editor = tree;
    else result.preview = { ...tree, state: obs.previewState, refs: obs.previewState === 'ready' };
  }

  if (args.screenshot) result.screenshots = await screenshots(env, id);
  aborted(env.signal);
  return result;
}

async function screenshots(env: ObserveEnv, id: number): Promise<{ editor: Shot; preview: Shot | null }> {
  const { page, signal } = env;
  if (!env.artifacts) throw new DriverError('OP_FAILED', 'This session has no artifacts folder to save screenshots in.');
  const dir = join(env.artifacts, 'snapshots');
  const mask = [page.locator(SECRET_INPUTS), page.frameLocator(PREVIEW_IFRAME).locator(SECRET_INPUTS)];
  const vp = await page.evaluate(() => ({ width: (globalThis as Dom).innerWidth as number, height: (globalThis as Dom).innerHeight as number }));
  const editorPng = await page.screenshot({ mask, timeout: 10_000 });
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
  const previewPng = clip ? await page.screenshot({ mask, clip, timeout: 10_000 }) : null;
  // A capture that outlived its request leaves nothing behind.
  aborted(signal);
  await mkdir(dir, { recursive: true });
  const editorPath = join(dir, `${String(id).padStart(4, '0')}-editor.png`);
  await writeFile(editorPath, editorPng);
  let preview: Shot | null = null;
  if (previewPng && clip) {
    const path = join(dir, `${String(id).padStart(4, '0')}-preview.png`);
    await writeFile(path, previewPng);
    preview = { path, width: clip.width, height: clip.height, clip };
  }
  return { editor: { path: editorPath, width: vp.width, height: vp.height }, preview };
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

/** The most elements a search follows up; past this it answers AMBIGUOUS_TARGET with the count. */
const MATCH_LIMIT = 50;

export async function uiLocate(env: ObserveEnv, args: LocateArgs): Promise<Located> {
  if (args.ref) {
    const obs = await observe(env);
    const minter = new Minter(env, obs);
    const { node } = await checkRef(env, args.ref, obs, minter);
    return located(node, minter, args);
  }
  // Find through Playwright's own role matching (what acting by role and name uses), then place each match in a full
  // observation by its ref: an accessibility snapshot leaves out a name a child repeats, so its names are not matched.
  const first = await observe(env);
  const firstMinter = new Minter(env, first);
  const scopes: Scope[] = args.scope === 'editor' ? ['editor'] : args.scope === 'preview' ? ['preview'] : ['editor', 'preview'];
  const roots: { scope: Scope; locator: (l: Page | Frame | Locator) => Locator; base: Page | Frame | Locator; byRef: boolean }[] = [];
  const byRole = (base: Page | Frame | Locator) => base.getByRole(args.role as Parameters<Page['getByRole']>[0], { ...(args.name !== undefined ? { name: args.name, exact: args.exact !== false } : {}) });
  if (args.within) {
    const { binding } = await checkRef(env, args.within, first, firstMinter);
    roots.push({ scope: binding.scope, base: env.page.locator(`aria-ref=${binding.pwRef}`), locator: byRole, byRef: true });
  } else {
    for (const scope of scopes) {
      if (scope === 'preview' && (first.previewState !== 'ready' || !first.docs.preview || !first.preview)) {
        if (args.scope === 'preview') throw new DriverError('TARGET_NOT_FOUND', `The preview is ${first.previewState === 'absent' ? 'not shown' : 'still loading'}: nothing in it can be found yet.`, { details: { preview: first.previewState, hint: 'Wait for context.preview.state to be "ready" (ui.snapshot), then locate again.' } });
        continue;
      }
      const tree = scope === 'editor' ? first.editor : first.preview!;
      if (args.region) for (const r of regionNodes(tree, args.region)) roots.push({ scope, base: env.page.locator(`aria-ref=${r.pwRef}`), locator: byRole, byRef: true });
      else roots.push({ scope, base: scope === 'editor' ? env.page : first.docs.preview!.frame, locator: byRole, byRef: false });
    }
  }
  const query = { role: args.role, ...(args.name !== undefined ? { name: args.name } : {}), ...(args.exact === false ? { exact: false } : {}), ...(args.region ? { region: args.region } : {}), ...(args.within ? { within: args.within } : {}), scope: args.scope ?? 'all' };
  if (!roots.length) throw new DriverError('TARGET_NOT_FOUND', args.region ? `There is no region "${args.region}" to search.` : 'There is nothing to search.', { details: { query, hint: REFRESH_HINT } });
  // How many elements match, before any snapshot of a match replaces a frame's last full one.
  const counts = await Promise.all(roots.map((r) => r.locator(r.base).count().catch(() => 0)));
  const count = counts.reduce((a, b) => a + b, 0);
  const pwRefs: { scope: Scope; ref: string }[] = [];
  if (count <= MATCH_LIMIT) {
    let partial = false;
    for (let i = 0; i < roots.length; i++) {
      if (!counts[i]) continue;
      // A container named by its ref is found through the frame's last full snapshot: take one again after any
      // snapshot of a single match replaced it (refs stay the same).
      if (partial && roots[i].byRef) await env.page.locator('body').ariaSnapshotJSON({ mode: 'ai', signal: env.signal });
      for (const ref of await refsOf(env.page, roots[i].locator(roots[i].base), MATCH_LIMIT)) pwRefs.push({ scope: roots[i].scope, ref });
      partial = true;
    }
  }
  const obs = await observe(env);
  const minter = new Minter(env, obs);
  if (args.within) await checkRef(env, args.within, obs, minter);
  const seen = new Set<string>();
  const found: Shaped[] = [];
  for (const { scope, ref } of pwRefs) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    const tree = scope === 'editor' ? obs.editor : obs.preview;
    const node = tree ? findByPwRef(tree, ref) : null;
    if (node) found.push(node);
  }
  if (count > MATCH_LIMIT) throw new DriverError('AMBIGUOUS_TARGET', `${count} elements are ${args.role}${args.name ? ` "${args.name}"` : ''}: name a region or a ref to search within.`, { details: { count, candidates: [], query, hint: 'Narrow it with "region" or "within" (a ref from ui.snapshot).' } });
  if (!found.length) throw new DriverError('TARGET_NOT_FOUND', `Nothing is ${args.role}${args.name ? ` "${args.name}"` : ''}${args.region ? ` in "${args.region}"` : ''}.`, { details: { query, preview: obs.previewState, hint: 'Take a ui.snapshot to see what there is.' } });
  if (found.length > 1) {
    const shown = found.slice(0, LIMITS.candidates);
    await minter.read(shown);
    const candidates = shown.map((n) => ({ ...(minter.ref(n) ? { ref: minter.ref(n)! } : {}), scope: n.scope, role: n.role, ...(n.name ? { name: n.name } : {}), region: n.regions }));
    throw new DriverError('AMBIGUOUS_TARGET', `${found.length} elements are ${args.role}${args.name ? ` "${args.name}"` : ''}: tell them apart by region, or use a ref.`, {
      details: { count: found.length, candidates, query, hint: 'Locate again with "region" set to one of the candidates\' regions, or use a candidate\'s ref.' }
    });
  }
  return located(found[0], minter, args);
}

async function located(node: Shaped, minter: Minter, args: LocateArgs): Promise<Located> {
  await minter.read([node]);
  const out = minter.describe(node);
  // An accessibility snapshot leaves out a name a child repeats; the match itself had it.
  if (!out.name && args.name !== undefined && args.exact !== false) out.name = args.name;
  if (node.children.length && out.ref) out.more = { children: node.children.length, nodes: node.size, continue: { within: out.ref, offset: 0 } };
  return { scope: node.scope, region: node.regions, node: out };
}

// ---------------------------------------------------------------------------
// The element a ref names, for acting on (issue #493)
// ---------------------------------------------------------------------------

/**
 * The element a ref names, checked as `ui.locate` checks it, then checked again inside its own document: a handle
 * belongs to one document, so acting through it can never reach an element of a page that replaced it. The caller
 * disposes of it.
 */
export async function elementFor(env: ObserveEnv, ref: string): Promise<ElementHandle> {
  argRef(ref, 'ref');
  const obs = await observe(env);
  const minter = new Minter(env, obs);
  const { binding } = await checkRef(env, ref, obs, minter);
  const handle = (await env.page.locator(`aria-ref=${binding.pwRef}`).elementHandle({ timeout: 2000 }).catch(() => null)) as ElementHandle | null;
  if (!handle) throw stale('gone', ref, `"${ref}" is no longer there.`);
  // Evaluated in the element's own document, which a reload or another page replaces.
  const doc = await handle.evaluate((el: Dom) => el.isConnected && `${(globalThis as Dom).performance.timeOrigin}|${(globalThis as Dom).location.pathname}`).catch(() => false);
  if (doc !== binding.doc) {
    await handle.dispose().catch(() => undefined);
    throw stale('document', ref, `"${ref}" was seen on a page that has since been replaced.`);
  }
  return handle;
}

/** Every node a tree shows, depth first. */
export function flatten(nodes: UiNode[]): UiNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children ?? [])]);
}
