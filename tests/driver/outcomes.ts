/**
 * Named conditions to wait for, and read-only checks of outcomes (issue #497).
 *
 * A wait names a condition and the request's deadline bounds it. The session samples what the condition needs (an
 * observation, the app's own state, its own record of the run), judges the sample with the functions here, and
 * answers with the sample that met it, or with TIMEOUT carrying the last sample, what was still pending, and the
 * errors the app and the page reported. Conditions that ask whether something changed (a save, the project revision,
 * an export) compare with a checkpoint the session takes just before each input it sends, in the same opening of the
 * project, so a save indicator that already said "Saved" before an edit never answers for it.
 *
 * The checks read independently of the editor's UI: the project's canonical documents on disk, and the files an
 * export wrote into the session's exports folder. Both are bounded and say when a search could not cover everything,
 * so a missing match is never mistaken for proof of absence.
 */
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import type { Page } from 'playwright';
import { resolveSessionPath } from './desktop.ts';
import type { Area } from './desktop.ts';
import { parseLocateArgs } from './observe.ts';
import type { Located, UiContext } from './observe.ts';
import { DriverError } from './protocol.ts';
import type { ErrorInfo, LocateArgs } from './protocol.ts';

/** The functions handed to `evaluate` run in the app's documents (see observe.ts). */
type Dom = any; // eslint-disable-line @typescript-eslint/no-explicit-any

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

export const CONDITIONS = ['ui.present', 'ui.absent', 'ui.context', 'preview.ready', 'save.settled', 'project.revision', 'export.finished', 'outcome.terminal'] as const;
export type ConditionName = (typeof CONDITIONS)[number];

export type Condition =
  | ({ condition: 'ui.present' | 'ui.absent' } & LocateArgs)
  | { condition: 'ui.context'; screen?: UiContext['screen']; mode?: UiContext['mode']; dialog?: string | null }
  | { condition: 'preview.ready'; path?: string }
  | { condition: 'save.settled'; changed: boolean }
  | { condition: 'project.revision'; atLeast?: number }
  | { condition: 'export.finished' }
  | { condition: 'outcome.terminal'; since: 'input' | 'start' };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function only(args: Record<string, unknown>, keys: string[], name: string) {
  for (const k of Object.keys(args)) if (k !== 'condition' && !keys.includes(k)) throw new DriverError('BAD_REQUEST', `The ${name} condition does not take "${k}".`);
}

/** Read `wait.for`'s args: `{ condition: name, ...its params }`. */
export function parseCondition(args: Record<string, unknown> | undefined): Condition {
  const a = args ?? {};
  const name = a.condition;
  if (typeof name !== 'string' || !(CONDITIONS as readonly string[]).includes(name)) throw new DriverError('BAD_REQUEST', `"condition" is one of ${CONDITIONS.join(', ')}.`, { details: { conditions: [...CONDITIONS] } });
  switch (name as ConditionName) {
    case 'ui.present':
    case 'ui.absent': {
      const { condition: _, ...rest } = a;
      if (rest.ref !== undefined) throw new DriverError('BAD_REQUEST', `${name} finds by role and name: use "within" to search inside a ref.`);
      if (typeof rest.role !== 'string') throw new DriverError('BAD_REQUEST', `${name} takes a "role" (and a "name", "region", "within" or "scope").`);
      return { condition: name as 'ui.present' | 'ui.absent', ...parseLocateArgs(rest) };
    }
    case 'ui.context': {
      only(a, ['screen', 'mode', 'dialog'], name);
      const out: Extract<Condition, { condition: 'ui.context' }> = { condition: 'ui.context' };
      if (a.screen !== undefined) {
        if (!['welcome', 'editor', 'other'].includes(a.screen as string)) throw new DriverError('BAD_REQUEST', '"screen" is welcome, editor or other.');
        out.screen = a.screen as UiContext['screen'];
      }
      if (a.mode !== undefined) {
        if (a.mode !== null && a.mode !== 'edit' && a.mode !== 'preview') throw new DriverError('BAD_REQUEST', '"mode" is edit, preview or null.');
        out.mode = a.mode as UiContext['mode'];
      }
      if (a.dialog !== undefined) {
        if (a.dialog !== null && (typeof a.dialog !== 'string' || !a.dialog)) throw new DriverError('BAD_REQUEST', '"dialog" is the topmost dialog\'s name, or null for none.');
        out.dialog = a.dialog as string | null;
      }
      if (Object.keys(out).length === 1) throw new DriverError('BAD_REQUEST', 'ui.context takes at least one of "screen", "mode" and "dialog".');
      return out;
    }
    case 'preview.ready':
      only(a, ['path'], name);
      if (a.path !== undefined && (typeof a.path !== 'string' || !a.path.startsWith('/'))) throw new DriverError('BAD_REQUEST', '"path" is the preview page\'s path, such as "/" or "/about/".');
      return { condition: 'preview.ready', ...(a.path !== undefined ? { path: a.path as string } : {}) };
    case 'save.settled':
      only(a, ['changed'], name);
      if (a.changed !== undefined && typeof a.changed !== 'boolean') throw new DriverError('BAD_REQUEST', '"changed" is true or false.');
      return { condition: 'save.settled', changed: a.changed !== false };
    case 'project.revision':
      only(a, ['atLeast'], name);
      if (a.atLeast !== undefined && (!Number.isInteger(a.atLeast) || (a.atLeast as number) < 0)) throw new DriverError('BAD_REQUEST', '"atLeast" is a revision: a whole number from 0.');
      return { condition: 'project.revision', ...(a.atLeast !== undefined ? { atLeast: a.atLeast as number } : {}) };
    case 'export.finished':
      only(a, [], name);
      return { condition: 'export.finished' };
    case 'outcome.terminal':
      only(a, ['since'], name);
      if (a.since !== undefined && a.since !== 'input' && a.since !== 'start') throw new DriverError('BAD_REQUEST', '"since" is input (the default) or start.');
      return { condition: 'outcome.terminal', since: (a.since as 'input' | 'start' | undefined) ?? 'input' };
  }
}

/** What a sample of the app needs to be judged against: the conditions that compare with the time of the last input. */
export interface Checkpoint {
  /** The journal entry of the input it was taken for. */
  seq: number;
  generation: number | null;
  opening: string | null;
  revision: number | null;
  newestExport: ExportBrief | null;
  /** How many page errors the session had seen. */
  pageErrors: number;
}

export interface Verdict {
  met: boolean;
  /** For a condition not met: what is still missing, in words. */
  pending?: string;
  /** For a condition met: what met it. */
  value?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The app's own state
// ---------------------------------------------------------------------------

export interface ExportBrief {
  kind: string;
  format: string;
  /** Where it was written: absolute in a probe; a session path in what a client gets. */
  path: string;
  revision: number;
  exportedAt: string;
}

/** One read of the app's state that the outcome conditions judge: the project snapshot and the visible indicators. */
export interface AppProbe {
  screen: 'welcome' | 'editor' | 'other';
  /** The project's opening (its workspaceKey), or null with none open. */
  opening: string | null;
  revision: number | null;
  /** The open project's folder, as the app reports it. */
  dir: string | null;
  runtime: { state: string; message?: string; detail?: string } | null;
  /** The toolbar's save indicator as it shows: its kind (saved, pending, ai, ask, wait, error) and its words. */
  save: { kind: string; text: string } | null;
  history: { canUndo: boolean; canRedo: boolean; undoLabel?: string; redoLabel?: string; applied: number } | null;
  exports: { count: number; newest: ExportBrief | null };
  /** The export dialog, while it is open: whether an export is running, and the result it shows. */
  exportView: { busy: boolean; result: { ok: boolean; text: string; fresh: boolean } | null } | null;
  conflicts: number;
  readOnly: boolean;
}

/** Where the probe keeps the export results already shown at a checkpoint, in the editor's document. */
const SEEN_RESULTS = 'siteorigin.driver.seenExportResults';

/**
 * Read the app's state from the editor's document: the project snapshot through the editor's own preload API, and
 * the save indicator and the export dialog as they show. Nothing is changed in the app; with `mark`, the export results
 * on screen now are remembered as seen, so only a result shown after this counts as fresh.
 */
export async function probeApp(page: Page, mark = false): Promise<AppProbe> {
  return (await page.evaluate(
    async ([key, markNow]: [string, boolean]) => {
      const g = globalThis as Dom;
      const d = g.document;
      const seen: WeakSet<object> = (g[Symbol.for(key)] ??= new WeakSet());
      const snap = await Promise.resolve(g.builder?.project?.snapshot?.()).catch(() => null);
      const screen = d.querySelector('.welcome') ? 'welcome' : d.querySelector('.editor') ? 'editor' : 'other';
      const saveEl = d.querySelector('.toolbar .save-state');
      const kinds = ['saved', 'pending', 'ai', 'ask', 'wait', 'error'];
      const save = saveEl ? { kind: kinds.find((k) => saveEl.classList.contains(k)) ?? 'unknown', text: String(saveEl.textContent ?? '').replace(/\s+/g, ' ').trim() } : null;
      const progress = d.querySelector('.export-progress');
      const resultEl = d.querySelector('.export-result');
      const result = resultEl ? { ok: resultEl.getAttribute('role') !== 'alert', text: String(resultEl.textContent ?? '').replace(/\s+/g, ' ').trim(), fresh: !seen.has(resultEl) } : null;
      if (markNow) for (const el of d.querySelectorAll('.export-result')) seen.add(el);
      const exportView = progress || resultEl ? { busy: !!progress && !!String(progress.textContent ?? '').trim(), result } : null;
      const recent = (snap?.recentExports ?? []) as { kind: string; format: string; path: string; revision: number; exportedAt: string }[];
      const newest = recent.length ? [...recent].sort((a, b) => (a.exportedAt < b.exportedAt ? 1 : a.exportedAt > b.exportedAt ? -1 : 0))[0] : null;
      const h = snap?.history;
      return {
        screen,
        opening: snap?.workspaceKey ?? null,
        revision: typeof snap?.revision === 'number' ? snap.revision : null,
        dir: snap?.dir ?? null,
        runtime: snap?.runtime ? { state: snap.runtime.state, ...(snap.runtime.message ? { message: snap.runtime.message } : {}), ...(snap.runtime.detail ? { detail: String(snap.runtime.detail).slice(0, 2000) } : {}) } : null,
        save,
        history: h ? { canUndo: !!h.canUndo, canRedo: !!h.canRedo, ...(h.undoLabel ? { undoLabel: h.undoLabel } : {}), ...(h.redoLabel ? { redoLabel: h.redoLabel } : {}), applied: (h.entries ?? []).filter((e: Dom) => e.applied).length } : null,
        exports: { count: recent.length, newest: newest ? { kind: newest.kind, format: newest.format, path: newest.path, revision: newest.revision, exportedAt: newest.exportedAt } : null },
        exportView,
        conflicts: snap?.conflicts?.length ?? 0,
        readOnly: !!snap?.readOnly
      };
    },
    [SEEN_RESULTS, mark] as [string, boolean]
  )) as AppProbe;
}

const sameExport = (a: ExportBrief | null, b: ExportBrief | null) => (!a && !b) || (!!a && !!b && a.path === b.path && a.exportedAt === b.exportedAt && a.kind === b.kind);

/** Judge an app condition against a probe and the checkpoint of the last input (null when none was sent). */
export function judgeApp(c: Extract<Condition, { condition: 'save.settled' | 'project.revision' | 'export.finished' }>, p: AppProbe, base: Checkpoint | null): Verdict {
  if (p.screen !== 'editor' || p.opening === null || p.revision === null) return { met: false, pending: `no project is open (the app shows ${p.screen === 'welcome' ? 'Welcome' : 'something else'})` };
  // A checkpoint from another opening (a project closed and opened again since) has nothing to compare with.
  const other = !!base && base.opening !== null && base.opening !== p.opening;
  switch (c.condition) {
    case 'save.settled': {
      if (c.changed) {
        if (!base || base.revision === null) return { met: false, pending: 'no input was sent to this project to compare with (use changed: false to wait for the indicator alone)' };
        if (other) return { met: false, pending: 'the project was opened again since the last input' };
        if (p.revision <= base.revision) return { met: false, pending: `the project is at revision ${p.revision}, as it was before the last input` };
      }
      if (p.save?.kind !== 'saved') return { met: false, pending: p.save ? `the editor shows "${p.save.text}"` : 'the editor shows no save state' };
      return { met: true, value: { revision: p.revision, save: p.save } };
    }
    case 'project.revision': {
      if (c.atLeast !== undefined) return p.revision >= c.atLeast ? { met: true, value: { revision: p.revision } } : { met: false, pending: `the project is at revision ${p.revision}, below ${c.atLeast}` };
      if (!base || base.revision === null) return { met: false, pending: 'no input was sent to this project to compare with (give atLeast)' };
      if (other) return { met: false, pending: 'the project was opened again since the last input' };
      return p.revision > base.revision ? { met: true, value: { revision: p.revision, before: base.revision } } : { met: false, pending: `the project is at revision ${p.revision}, as it was before the last input` };
    }
    case 'export.finished': {
      const busy = !!p.exportView?.busy;
      const result = p.exportView?.result ?? null;
      const before = other ? null : (base?.newestExport ?? null);
      const fresh = !!p.exports.newest && !sameExport(p.exports.newest, before);
      if (fresh && !busy) return { met: true, value: { outcome: 'exported', export: p.exports.newest, ...(result?.fresh && result.ok ? { message: result.text } : {}) } };
      if (result?.fresh && !result.ok && !busy) return { met: true, value: { outcome: 'failed', message: result.text } };
      return { met: false, pending: busy ? 'the export is still running' : 'no export has finished since the last input' };
    }
  }
}

/** What the session knows about how the run is going, for `outcome.terminal`. */
export interface RunState {
  appExited: boolean;
  /** The bound window closed and none replaced it. */
  windowClosed: boolean;
  /** Page errors since the checkpoint the condition compares with. */
  pageErrors: string[];
  runtime: AppProbe['runtime'];
}

/** Judge `outcome.terminal`: the app ended, its window closed, the page raised an error, or the preview failed. */
export function judgeTerminal(s: RunState): Verdict {
  if (s.appExited) return { met: true, value: { outcome: 'app-exited' } };
  if (s.windowClosed) return { met: true, value: { outcome: 'window-closed' } };
  if (s.pageErrors.length) return { met: true, value: { outcome: 'page-error', errors: s.pageErrors } };
  if (s.runtime && (s.runtime.state === 'error' || s.runtime.state === 'unavailable')) return { met: true, value: { outcome: `runtime-${s.runtime.state}`, runtime: s.runtime } };
  return { met: false, pending: 'the app is running with its window, no page error and no preview failure' };
}

/** Judge a UI context condition against an observation's context. */
export function judgeContext(c: Extract<Condition, { condition: 'ui.context' | 'preview.ready' }>, ctx: UiContext): Verdict {
  const misses: string[] = [];
  if (c.condition === 'preview.ready') {
    if (ctx.preview.state !== 'ready') misses.push(`the preview is ${ctx.preview.state === 'absent' ? 'not shown' : 'still loading'}`);
    else if (c.path !== undefined && ctx.preview.path !== c.path) misses.push(`the preview shows ${ctx.preview.path ?? 'no page'}, not ${c.path}`);
    return misses.length ? { met: false, pending: misses.join('; ') } : { met: true, value: { preview: ctx.preview } };
  }
  if (c.screen !== undefined && ctx.screen !== c.screen) misses.push(`the screen is ${ctx.screen}, not ${c.screen}`);
  if (c.mode !== undefined && ctx.mode !== c.mode) misses.push(`the mode is ${ctx.mode ?? 'none'}, not ${c.mode ?? 'none'}`);
  if (c.dialog !== undefined) {
    const now = ctx.dialog?.name ?? (ctx.dialog ? '' : null);
    if (c.dialog === null ? now !== null : now !== c.dialog) misses.push(now === null ? 'no dialog is open' : `the topmost dialog is "${now}"`);
  }
  return misses.length ? { met: false, pending: misses.join('; ') } : { met: true, value: { screen: ctx.screen, mode: ctx.mode, dialog: ctx.dialog } };
}

/** One search for a `ui.present` or `ui.absent` condition: what ui.locate found, or the error it answered. */
export type LocateSample = { ok: true; located: Located } | { ok: false; error: ErrorInfo };

/**
 * Judge presence or absence. Present: at least one match (several are fine: the wait is not choosing one). Absent:
 * no match in a search that covered its whole scope; a preview still loading has not been searched, and a search
 * that could not place every match proves nothing.
 */
export function judgeLocate(c: Extract<Condition, { condition: 'ui.present' | 'ui.absent' }>, s: LocateSample): Verdict {
  const what = `${c.role}${c.name !== undefined ? ` "${c.name}"` : ''}${c.region ? ` in "${c.region}"` : ''}`;
  if (s.ok) return c.condition === 'ui.present' ? { met: true, value: { count: 1, node: s.located.node, scope: s.located.scope, region: s.located.region } } : { met: false, pending: `a ${what} is there` };
  const { code, details } = s.error;
  if (code === 'AMBIGUOUS_TARGET') return c.condition === 'ui.present' ? { met: true, value: { count: details?.count, candidates: details?.candidates } } : { met: false, pending: `${String(details?.count ?? 'several')} ${what} are there` };
  if (code === 'TARGET_NOT_FOUND') {
    if (c.condition === 'ui.present') return { met: false, pending: `no ${what} is there${details?.preview && details.preview !== 'ready' ? ` (the preview is ${String(details.preview)})` : ''}` };
    // A search of a scope that includes the preview proves nothing while the preview is loading.
    if (c.scope !== 'editor' && details?.preview === 'loading') return { met: false, pending: 'the preview is still loading, so it has not been searched' };
    return { met: true, value: { count: 0 } };
  }
  return { met: false, pending: `the search could not be completed: ${s.error.message}` };
}

// ---------------------------------------------------------------------------
// Session paths
// ---------------------------------------------------------------------------

/** A path inside the session's folders as a session path (`exports/site/index.html`), or null for one outside them. */
export function toSessionPath(areas: Record<Area, string>, abs: string): string | null {
  for (const [area, dir] of Object.entries(areas)) {
    const rel = relative(dir, abs);
    if (rel === '') return area;
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return `${area}/${rel.split(sep).join('/')}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The project on disk
// ---------------------------------------------------------------------------

/** Limits on reading a project's documents. */
export const DOC_LIMITS = { files: 2000, fileBytes: 4 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, pages: 200, matches: 50, excerpt: 60 };

export interface DocMatch {
  /** The document, relative to the project folder. */
  file: string;
  /** Where in it: a JSON path such as `nodes.n4.props.heading`. */
  pointer: string;
  excerpt: string;
}

export interface ProjectDocs {
  name: string | null;
  site: { name: string | null; language: string | null; homePageId: string | null };
  pages: { id: string; title: string; route: string; home: boolean; draft: boolean }[];
  /** More pages than the summary lists. */
  morePages?: number;
  find?: { text: string; matches: DocMatch[]; more: boolean; files: number; complete: boolean; skipped?: string[] };
}

const readJsonFile = async (file: string, limit: number): Promise<unknown> => {
  const s = await lstat(file).catch(() => null);
  if (!s?.isFile() || s.size > limit) return undefined;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
};

const str = (v: unknown) => (typeof v === 'string' ? v : null);

function excerptAround(text: string, at: number, len: number, room = DOC_LIMITS.excerpt): string {
  const start = Math.max(0, at - room);
  const end = Math.min(text.length, at + len + room);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`;
}

/** Every string in a JSON value that contains `text`, with where it is. */
function findInJson(v: unknown, text: string, file: string, out: DocMatch[], limit: number, path: string[] = []): boolean {
  if (out.length >= limit) return true;
  if (typeof v === 'string') {
    const at = v.indexOf(text);
    if (at >= 0) out.push({ file, pointer: path.join('.') || '(root)', excerpt: excerptAround(v, at, text.length) });
    return out.length >= limit;
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) if (findInJson(v[i], text, file, out, limit, [...path, String(i)])) return true;
    return false;
  }
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (findInJson(x, text, file, out, limit, [...path, k])) return true;
  return false;
}

/** The JSON documents of a project: its manifest and everything under siteorigin/, in name order, never through a link. */
async function documentFiles(dir: string, limit: number): Promise<{ files: string[]; complete: boolean; skipped: string[] }> {
  const files: string[] = [];
  const skipped: string[] = [];
  let complete = true;
  const manifest = join(dir, 'siteorigin.project.json');
  if ((await lstat(manifest).catch(() => null))?.isFile()) files.push('siteorigin.project.json');
  const walk = async (rel: string) => {
    const entries = (await readdir(join(dir, rel), { withFileTypes: true }).catch(() => [])).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      const child = `${rel}/${e.name}`;
      if (e.isSymbolicLink()) skipped.push(`${child} (a link)`);
      else if (e.isDirectory()) await walk(child);
      else if (e.isFile() && e.name.endsWith('.json')) {
        if (files.length >= limit) {
          complete = false;
          return;
        }
        files.push(child);
      }
    }
  };
  if ((await lstat(join(dir, 'siteorigin')).catch(() => null))?.isDirectory()) await walk('siteorigin');
  return { files, complete, skipped };
}

/**
 * Read a project's canonical documents from disk: the site, its pages (title, route, home, draft), and with `find`,
 * every document string that contains the text. Never through the app: what this reads is what the next opening of
 * the project, or an export, starts from.
 */
export async function readProjectDocs(dir: string, opts: { find?: string } = {}): Promise<ProjectDocs> {
  const manifest = (await readJsonFile(join(dir, 'siteorigin.project.json'), DOC_LIMITS.fileBytes)) as Record<string, unknown> | undefined;
  const site = (await readJsonFile(join(dir, 'siteorigin', 'site.json'), DOC_LIMITS.fileBytes)) as Record<string, unknown> | undefined;
  const homePageId = str(site?.homePageId);
  const pageNames = (await readdir(join(dir, 'siteorigin', 'pages')).catch(() => [] as string[])).filter((n) => n.endsWith('.json')).sort();
  const pages: ProjectDocs['pages'] = [];
  for (const n of pageNames.slice(0, DOC_LIMITS.pages)) {
    const p = (await readJsonFile(join(dir, 'siteorigin', 'pages', n), DOC_LIMITS.fileBytes)) as Record<string, unknown> | undefined;
    if (!p) continue;
    const id = str(p.id) ?? n.replace(/\.json$/, '');
    pages.push({ id, title: str(p.title) ?? '', route: str(p.route) ?? '', home: id === homePageId, draft: p.draft === true });
  }
  pages.sort((a, b) => (a.home === b.home ? (a.route < b.route ? -1 : a.route > b.route ? 1 : 0) : a.home ? -1 : 1));
  const out: ProjectDocs = {
    name: str(manifest?.workingCopyName) ?? str(manifest?.name),
    site: { name: str(site?.name), language: str(site?.language), homePageId },
    pages,
    ...(pageNames.length > DOC_LIMITS.pages ? { morePages: pageNames.length - DOC_LIMITS.pages } : {})
  };
  if (opts.find !== undefined) {
    const { files, complete: listed, skipped } = await documentFiles(dir, DOC_LIMITS.files);
    const matches: DocMatch[] = [];
    let complete = listed;
    let total = 0;
    let more = false;
    for (const f of files) {
      const abs = join(dir, f);
      const s = await lstat(abs).catch(() => null);
      if (!s?.isFile()) continue;
      if (s.size > DOC_LIMITS.fileBytes || total + s.size > DOC_LIMITS.totalBytes) {
        complete = false;
        skipped.push(`${f} (too large to read)`);
        continue;
      }
      total += s.size;
      const doc = await readJsonFile(abs, DOC_LIMITS.fileBytes);
      if (doc === undefined) {
        skipped.push(`${f} (not JSON)`);
        continue;
      }
      if (findInJson(doc, opts.find, f, matches, DOC_LIMITS.matches)) {
        more = true;
        break;
      }
    }
    out.find = { text: opts.find, matches, more, files: files.length, complete, ...(skipped.length ? { skipped: skipped.slice(0, 20) } : {}) };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Exported files
// ---------------------------------------------------------------------------

export const EXPORT_LIMITS = { files: 5000, listed: 200, fileBytes: 2 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, matches: 50, text: 8 * 1024 };

/** Files read as text when searched; anything else is listed but not read. */
const TEXT_EXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.json', '.txt', '.xml', '.svg', '.md', '.webmanifest', '.svelte', '.ts', '.toml', '.yml', '.yaml', '.csv']);

export interface ExportMatch {
  /** The file, relative to the inspected folder (or its own name). */
  file: string;
  line: number;
  excerpt: string;
}

export interface ExportInspection {
  /** The session path inspected. */
  path: string;
  type: 'file' | 'folder';
  /** For a folder: how many files it holds (as far as counted), and the first ones by path. */
  files?: number;
  listed?: { file: string; bytes: number }[];
  /** For a file: its size and digest, and its text (cut to length) when it is text and was asked for. */
  bytes?: number;
  sha256?: string;
  text?: string;
  truncated?: boolean;
  find?: { text: string; matches: ExportMatch[]; more: boolean; searched: number; complete: boolean; skipped?: string[] };
  /** Entries a folder listing passed over (links are never followed). */
  skipped?: string[];
}

export interface InspectArgs {
  path: string;
  find?: string;
  /** For a folder: inspect one file in it, by its path relative to the folder. */
  file?: string;
  /** Return a text file's contents (cut to length). */
  read?: boolean;
}

export function parseInspectArgs(args: Record<string, unknown> | undefined): InspectArgs {
  const a = args ?? {};
  for (const k of Object.keys(a)) if (!['path', 'find', 'file', 'read'].includes(k)) throw new DriverError('BAD_REQUEST', `exports.inspect does not take "${k}".`);
  if (typeof a.path !== 'string' || !a.path) throw new DriverError('BAD_REQUEST', '"path" is a session path in exports/, such as "exports/my-site-site".');
  if (a.find !== undefined && (typeof a.find !== 'string' || !a.find)) throw new DriverError('BAD_REQUEST', '"find" is the text to look for.');
  if (a.file !== undefined && (typeof a.file !== 'string' || !a.file || isAbsolute(a.file) || a.file.split(/[\\/]/).includes('..'))) throw new DriverError('BAD_REQUEST', '"file" is a path inside the folder, such as "index.html".');
  if (a.read !== undefined && typeof a.read !== 'boolean') throw new DriverError('BAD_REQUEST', '"read" is true or false.');
  return a as unknown as InspectArgs;
}

const isText = (name: string, head: Buffer) => TEXT_EXT.has(extname(name).toLowerCase()) && !head.includes(0);

function findInText(text: string, find: string, file: string, out: ExportMatch[], limit: number): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(find, from);
    if (at < 0) return false;
    if (out.length >= limit) return true;
    const line = text.slice(0, at).split('\n').length;
    out.push({ file, line, excerpt: excerptAround(text, at, find.length) });
    from = at + find.length;
  }
}

/** A file's contents, read only while it is still really inside `root` (no link put in its way since it was listed). */
async function readInside(root: string, abs: string): Promise<Buffer | null> {
  const real = await realpath(abs).catch(() => null);
  if (!real || real !== abs) return null;
  const rel = relative(root, real);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return readFile(real);
}

/**
 * Inspect what an export wrote into the session's exports folder: a file, or a folder (its files, one of them, or a
 * search of its text files for `find`). Read-only and bounded; links are listed but never followed, and a search that
 * could not read everything says so (`complete: false`).
 */
export async function inspectExport(areas: Record<Area, string>, args: InspectArgs): Promise<ExportInspection> {
  const exportsRoot = areas.exports;
  const base = await resolveSessionPath(areas, args.path, ['exports']);
  const logical = toSessionPath(areas, base) ?? args.path;
  const s = await lstat(base).catch(() => null);
  if (!s) throw new DriverError('TARGET_NOT_FOUND', `There is nothing at ${logical}.`, { details: { path: logical } });
  if (s.isSymbolicLink()) throw new DriverError('BAD_REQUEST', `${logical} is a link; only files the export wrote are inspected.`);
  const one = async (abs: string, name: string): Promise<ExportInspection> => {
    const st = await lstat(abs).catch(() => null);
    if (!st) throw new DriverError('TARGET_NOT_FOUND', `There is no ${name} in ${logical}.`, { details: { path: logical, file: name } });
    if (!st.isFile()) throw new DriverError('BAD_REQUEST', `${name} is not a file.`);
    if (st.size > EXPORT_LIMITS.fileBytes) return { path: logical, type: 'file', bytes: st.size, ...(args.find !== undefined ? { find: { text: args.find, matches: [], more: false, searched: 0, complete: false, skipped: [`${name} (too large to read)`] } } : {}) };
    const buf = await readInside(exportsRoot, abs);
    if (!buf) throw new DriverError('BAD_REQUEST', `${name} is not inside the exports folder.`);
    const text = isText(name, buf.subarray(0, 8192)) ? buf.toString('utf8') : null;
    const out: ExportInspection = { path: logical, type: 'file', bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
    if (args.read && text !== null) {
      out.text = text.slice(0, EXPORT_LIMITS.text);
      if (text.length > EXPORT_LIMITS.text) out.truncated = true;
    }
    if (args.find !== undefined) {
      const matches: ExportMatch[] = [];
      const more = text !== null && findInText(text, args.find, name, matches, EXPORT_LIMITS.matches);
      out.find = { text: args.find, matches, more, searched: text === null ? 0 : 1, complete: text !== null, ...(text === null ? { skipped: [`${name} (not text)`] } : {}) };
    }
    return out;
  };
  if (s.isFile()) {
    if (args.file !== undefined) throw new DriverError('BAD_REQUEST', `${logical} is a file: "file" picks a file inside a folder.`);
    return one(base, logical.split('/').pop()!);
  }
  if (!s.isDirectory()) throw new DriverError('BAD_REQUEST', `${logical} is neither a file nor a folder.`);
  if (args.file !== undefined) {
    const inspected = await one(join(base, ...args.file.split(/[\\/]/)), args.file);
    return { ...inspected, path: `${logical}/${args.file.split(/[\\/]/).join('/')}` };
  }
  // The folder: its files in path order, never through a link.
  const files: { file: string; bytes: number }[] = [];
  const skipped: string[] = [];
  let counted = true;
  const walk = async (rel: string) => {
    const entries = (await readdir(join(base, rel), { withFileTypes: true }).catch(() => [])).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      if (files.length >= EXPORT_LIMITS.files) {
        counted = false;
        return;
      }
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) skipped.push(`${child} (a link)`);
      else if (e.isDirectory()) await walk(child);
      else if (e.isFile()) files.push({ file: child, bytes: (await stat(join(base, child)).catch(() => null))?.size ?? 0 });
    }
  };
  await walk('');
  const out: ExportInspection = { path: logical, type: 'folder', files: files.length, listed: files.slice(0, EXPORT_LIMITS.listed) };
  if (args.find !== undefined) {
    const matches: ExportMatch[] = [];
    let complete = counted;
    let searched = 0;
    let total = 0;
    let more = false;
    for (const f of files) {
      if (!TEXT_EXT.has(extname(f.file).toLowerCase())) continue;
      if (f.bytes > EXPORT_LIMITS.fileBytes || total + f.bytes > EXPORT_LIMITS.totalBytes) {
        complete = false;
        skipped.push(`${f.file} (too large to read)`);
        continue;
      }
      const buf = await readInside(exportsRoot, join(base, ...f.file.split('/')));
      if (!buf) {
        complete = false;
        skipped.push(`${f.file} (moved out of the exports folder)`);
        continue;
      }
      total += buf.length;
      if (buf.subarray(0, 8192).includes(0)) continue;
      searched++;
      if (findInText(buf.toString('utf8'), args.find, f.file, matches, EXPORT_LIMITS.matches)) {
        more = true;
        break;
      }
    }
    out.find = { text: args.find, matches, more, searched, complete, ...(skipped.length ? { skipped: skipped.slice(0, 20) } : {}) };
  } else if (skipped.length) out.skipped = skipped.slice(0, 20);
  return out;
}
