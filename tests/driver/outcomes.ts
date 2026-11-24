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
import { constants as fsConstants } from 'node:fs';
import type { Dirent } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
  /** Whether the app could be read then: an unread checkpoint is not an empty one, and nothing compares with it. */
  known: boolean;
  generation: number | null;
  opening: string | null;
  revision: number | null;
  newestExport: ExportBrief | null;
  /** The export report the dialog kept then (its id, shown or hidden by a running export), if any. */
  exportReport: string | null;
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
  /**
   * The export dialog, while it is open: whether an export is running, the report it shows (with its id), and the id of
   * the report it keeps, shown or not (a running export hides it; a cancelled one shows it again).
   */
  exportView: { busy: boolean; result: { ok: boolean; text: string; report: string | null } | null; kept?: string | null } | null;
  /** The project snapshot could not be read (the request failed): nothing about the project is known. */
  unreadable?: true;
  conflicts: number;
  readOnly: boolean;
}

/**
 * Read the app's state from the editor's document: the project snapshot through the editor's own preload API, and
 * the save indicator and the export dialog as they show. Nothing in the app is changed. The export report shown is
 * named by its own id (`data-report`), so the same report drawn again after a cancelled retry is told from a new one.
 */
export async function probeApp(page: Page): Promise<AppProbe> {
  return (await page.evaluate(async () => {
      const g = globalThis as Dom;
      const d = g.document;
      let unreadable = false;
      const snap = await Promise.resolve(g.builder?.project?.snapshot?.()).catch(() => {
        unreadable = true;
        return null;
      });
      const screen = d.querySelector('.welcome') ? 'welcome' : d.querySelector('.editor') ? 'editor' : 'other';
      const saveEl = d.querySelector('.toolbar .save-state');
      const kinds = ['saved', 'pending', 'ai', 'ask', 'wait', 'error'];
      const save = saveEl ? { kind: kinds.find((k) => saveEl.classList.contains(k)) ?? 'unknown', text: String(saveEl.textContent ?? '').replace(/\s+/g, ' ').trim() } : null;
      const progress = d.querySelector('.export-progress');
      const resultEl = d.querySelector('.export-result');
      const result = resultEl ? { ok: resultEl.getAttribute('role') !== 'alert', text: String(resultEl.textContent ?? '').replace(/\s+/g, ' ').trim(), report: resultEl.getAttribute('data-report') } : null;
      const exportView = progress || resultEl ? { busy: !!progress && !!String(progress.textContent ?? '').trim(), result, kept: progress?.getAttribute('data-kept-report') || result?.report || null } : null;
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
        readOnly: !!snap?.readOnly,
        ...(unreadable ? { unreadable: true } : {})
      };
  })) as AppProbe;
}

const sameExport = (a: ExportBrief | null, b: ExportBrief | null) => (!a && !b) || (!!a && !!b && a.path === b.path && a.exportedAt === b.exportedAt && a.kind === b.kind);

/** Judge an app condition against a probe and the checkpoint of the last input (null when none was sent). */
export function judgeApp(c: Extract<Condition, { condition: 'save.settled' | 'project.revision' | 'export.finished' }>, p: AppProbe, base: Checkpoint | null): Verdict {
  if (p.unreadable) return { met: false, pending: 'the project could not be read' };
  if (p.screen !== 'editor' || p.opening === null || p.revision === null) return { met: false, pending: `no project is open (the app shows ${p.screen === 'welcome' ? 'Welcome' : 'something else'})` };
  // A checkpoint that could not be read says nothing about what was there: no change is judged against it.
  const unread = !!base && !base.known;
  const unreadPending = 'the app could not be read just before the last input, so there is nothing to compare with';
  // A checkpoint from another opening (a project closed and opened again since) has nothing to compare with.
  const other = !!base && base.opening !== null && base.opening !== p.opening;
  switch (c.condition) {
    case 'save.settled': {
      if (c.changed) {
        if (unread) return { met: false, pending: unreadPending };
        if (!base || base.revision === null) return { met: false, pending: 'no input was sent to this project to compare with (use changed: false to wait for the indicator alone)' };
        if (other) return { met: false, pending: 'the project was opened again since the last input' };
        if (p.revision <= base.revision) return { met: false, pending: `the project is at revision ${p.revision}, as it was before the last input` };
      }
      if (p.save?.kind !== 'saved') return { met: false, pending: p.save ? `the editor shows "${p.save.text}"` : 'the editor shows no save state' };
      return { met: true, value: { revision: p.revision, save: p.save } };
    }
    case 'project.revision': {
      if (c.atLeast !== undefined) return p.revision >= c.atLeast ? { met: true, value: { revision: p.revision } } : { met: false, pending: `the project is at revision ${p.revision}, below ${c.atLeast}` };
      if (unread) return { met: false, pending: unreadPending };
      if (!base || base.revision === null) return { met: false, pending: 'no input was sent to this project to compare with (give atLeast)' };
      if (other) return { met: false, pending: 'the project was opened again since the last input' };
      return p.revision > base.revision ? { met: true, value: { revision: p.revision, before: base.revision } } : { met: false, pending: `the project is at revision ${p.revision}, as it was before the last input` };
    }
    case 'export.finished': {
      if (unread) return { met: false, pending: unreadPending };
      const busy = !!p.exportView?.busy;
      const result = p.exportView?.result ?? null;
      const before = other ? null : (base?.newestExport ?? null);
      const fresh = !!p.exports.newest && !sameExport(p.exports.newest, before);
      // A report is new when it is not the one shown at the last input; one with no id cannot be told apart.
      const freshReport = !!result?.report && result.report !== (base?.exportReport ?? null);
      if (fresh && !busy) return { met: true, value: { outcome: 'exported', export: p.exports.newest, ...(freshReport && result!.ok ? { message: result!.text } : {}) } };
      if (freshReport && !result!.ok && !busy) return { met: true, value: { outcome: 'failed', message: result!.text } };
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
export function judgeLocate(c: Extract<Condition, { condition: 'ui.present' | 'ui.absent' }>, s: LocateSample, searchesPreview = c.scope !== 'editor'): Verdict {
  const what = `${c.role}${c.name !== undefined ? ` "${c.name}"` : ''}${c.region ? ` in "${c.region}"` : ''}`;
  if (s.ok) return c.condition === 'ui.present' ? { met: true, value: { count: 1, node: s.located.node, scope: s.located.scope, region: s.located.region } } : { met: false, pending: `a ${what} is there` };
  const { code, details } = s.error;
  if (code === 'AMBIGUOUS_TARGET') return c.condition === 'ui.present' ? { met: true, value: { count: details?.count, candidates: details?.candidates } } : { met: false, pending: `${String(details?.count ?? 'several')} ${what} are there` };
  if (code === 'TARGET_NOT_FOUND') {
    if (c.condition === 'ui.present') return { met: false, pending: `no ${what} is there${details?.preview && details.preview !== 'ready' ? ` (the preview is ${String(details.preview)})` : ''}` };
    // A search whose scope includes the preview proves nothing while the preview is loading, or when it cannot say.
    if (searchesPreview && details?.preview !== 'ready' && details?.preview !== 'absent') return { met: false, pending: details?.preview === 'loading' ? 'the preview is still loading, so it has not been searched' : 'the search could not say whether the preview was searched' };
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
// Reading files safely
// ---------------------------------------------------------------------------

/** Limits on any walk of a folder: how many entries it visits in all, and how many it reads from one folder. */
export const WALK_LIMITS = { visits: 20_000, perFolder: 5_000 };

/** Whether no link stands on the way from `root` to `rel` (inside it): what is not there yet is no link either. */
async function noLinks(root: string, rel: string): Promise<boolean> {
  let at = root;
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    at = join(at, part);
    const l = await lstat(at).catch(() => null);
    if (!l) return true;
    if (l.isSymbolicLink()) return false;
  }
  return true;
}

/**
 * Read a file inside `root` with at most `limit` bytes: only while it, and every folder on the way to it, are no links
 * (checked before opening, and the opened file checked to be the same one), so nothing outside is read through a link
 * put in the way. Null when it is not there or not plain; `too-large` past the limit.
 */
async function readPlain(root: string, rel: string, limit: number): Promise<Buffer | null | 'too-large'> {
  if (!(await noLinks(root, rel))) return null;
  const abs = join(root, rel);
  const before = await lstat(abs).catch(() => null);
  if (!before?.isFile()) return null;
  if (before.size > limit) return 'too-large';
  const fh = await open(abs, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)).catch(() => null);
  if (!fh) return null;
  try {
    const st = await fh.stat();
    if (st.ino !== before.ino || st.dev !== before.dev || !st.isFile()) return null;
    // A folder on the way swapped for a link after the check: the file opened is not the one inside `root`.
    if (!(await stillInside(root, rel, st))) return null;
    if (st.size > limit) return 'too-large';
    const buf = Buffer.alloc(Math.min(st.size, limit) + 1);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead > limit) return 'too-large';
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** Whether `root/rel` still really is inside `root`, and is the file `st` describes (when given). */
async function stillInside(root: string, rel: string, st?: { ino: number; dev: number }): Promise<boolean> {
  const real = await realpath(join(root, rel)).catch(() => null);
  if (!real || real !== join(root, rel)) return false;
  if (!st) return true;
  const now = await lstat(real).catch(() => null);
  return !!now && now.ino === st.ino && now.dev === st.dev;
}

interface Walk {
  /** Files, by path relative to the root, in path order. */
  files: { file: string; bytes: number }[];
  /** Whether every folder was read whole. */
  complete: boolean;
  skipped: string[];
}

/**
 * Every plain file under `root/rel`, never through a link, in path order: bounded by the entries visited (folders
 * count too) and per folder, and stopped when `signal` aborts. What it could not read makes it incomplete.
 */
async function walkFiles(root: string, rel: string, keep: (name: string) => boolean, maxFiles: number, signal?: AbortSignal): Promise<Walk> {
  const out: Walk = { files: [], complete: true, skipped: [] };
  let visits = 0;
  const walk = async (dirRel: string): Promise<void> => {
    if (signal?.aborted) throw new DriverError('TIMEOUT', 'The request ran out of time.');
    const dir = (await stillInside(root, dirRel)) ? await opendir(join(root, dirRel)).catch(() => null) : null;
    if (!dir) {
      out.complete = false;
      out.skipped.push(`${dirRel || '.'} (could not be read)`);
      return;
    }
    const entries: Dirent[] = [];
    try {
      for await (const e of dir) {
        if (entries.length >= WALK_LIMITS.perFolder) {
          out.complete = false;
          out.skipped.push(`${dirRel || '.'} (more than ${WALK_LIMITS.perFolder} entries)`);
          break;
        }
        entries.push(e);
      }
    } catch {
      out.complete = false;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (++visits > WALK_LIMITS.visits || out.files.length >= maxFiles) {
        out.complete = false;
        return;
      }
      const child = dirRel ? `${dirRel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        // Never followed, so what it leads to was not read.
        out.skipped.push(`${child} (a link)`);
        out.complete = false;
      } else if (e.isDirectory()) {
        await walk(child);
        if (!out.complete && (visits > WALK_LIMITS.visits || out.files.length >= maxFiles)) return;
      } else if (e.isFile() && keep(e.name)) out.files.push({ file: child, bytes: (await lstat(join(root, child)).catch(() => null))?.size ?? 0 });
    }
  };
  if (await noLinks(root, rel)) await walk(rel);
  else {
    out.complete = false;
    out.skipped.push(`${rel} (a link)`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The project on disk
// ---------------------------------------------------------------------------

/** Limits on reading a project's documents: one byte budget for the summary and the search together. */
export const DOC_LIMITS = { files: 2000, fileBytes: 4 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, pages: 200, matches: 50, excerpt: 60, text: 200 };

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
  /** Whether every page document was read. */
  pagesComplete: boolean;
  find?: { text: string; matches: DocMatch[]; more: boolean; files: number; complete: boolean; skipped?: string[] };
}

const cut = (v: string, max = DOC_LIMITS.text) => (v.length > max ? `${v.slice(0, max)}…` : v);
const str = (v: unknown) => (typeof v === 'string' ? cut(v) : null);

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

/**
 * Read a project's canonical documents from disk: the site, its pages (title, route, home, draft), and with `find`,
 * every document string that contains the text. Never through the app, and never through a link: what this reads is
 * what the next opening of the project, or an export, starts from. One byte budget covers everything it reads.
 */
export async function readProjectDocs(dir: string, opts: { find?: string; signal?: AbortSignal } = {}): Promise<ProjectDocs> {
  let budget = DOC_LIMITS.totalBytes;
  /** Each document read once, for the summary and the search alike. */
  const read = new Map<string, { doc?: unknown; why?: string }>();
  /** A document as JSON: undefined when missing, not JSON, too large, or past the budget (and why, in `why`). */
  const readJson = async (rel: string): Promise<{ doc?: unknown; why?: string }> => {
    const known = read.get(rel);
    if (known) return known;
    if (opts.signal?.aborted) throw new DriverError('TIMEOUT', 'The request ran out of time.');
    const buf = await readPlain(dir, rel, Math.min(DOC_LIMITS.fileBytes, budget));
    let out: { doc?: unknown; why?: string };
    if (buf === null) out = { why: 'missing or not a plain file' };
    else if (buf === 'too-large') out = { why: 'too large to read' };
    else {
      budget -= buf.length;
      try {
        out = { doc: JSON.parse(buf.toString('utf8')) };
      } catch {
        out = { why: 'not JSON' };
      }
    }
    read.set(rel, out);
    return out;
  };
  const manifest = (await readJson('siteorigin.project.json')).doc as Record<string, unknown> | undefined;
  const site = (await readJson('siteorigin/site.json')).doc as Record<string, unknown> | undefined;
  const homePageId = typeof site?.homePageId === 'string' ? site.homePageId : null;
  const listed = await walkFiles(dir, 'siteorigin/pages', (n) => n.endsWith('.json'), DOC_LIMITS.files, opts.signal);
  const pageFiles = listed.files.filter((f) => !f.file.slice('siteorigin/pages/'.length).includes('/'));
  const pages: ProjectDocs['pages'] = [];
  let pagesComplete = listed.complete;
  for (const f of pageFiles.slice(0, DOC_LIMITS.pages)) {
    const { doc } = await readJson(f.file);
    const p = doc as Record<string, unknown> | undefined;
    if (!p) {
      pagesComplete = false;
      continue;
    }
    const id = typeof p.id === 'string' ? p.id : f.file.slice('siteorigin/pages/'.length).replace(/\.json$/, '');
    // A route is kept whole (to the length any page could have): it is what a client hands back to preview.ready.
    pages.push({ id: cut(id), title: str(p.title) ?? '', route: typeof p.route === 'string' ? cut(p.route, 2000) : '', home: id === homePageId, draft: p.draft === true });
  }
  pages.sort((a, b) => (a.home === b.home ? (a.route < b.route ? -1 : a.route > b.route ? 1 : 0) : a.home ? -1 : 1));
  const out: ProjectDocs = {
    name: str(manifest?.workingCopyName) ?? str(manifest?.name),
    site: { name: str(site?.name), language: str(site?.language), homePageId: homePageId === null ? null : cut(homePageId) },
    pages,
    ...(pageFiles.length > DOC_LIMITS.pages ? { morePages: pageFiles.length - DOC_LIMITS.pages } : {}),
    pagesComplete: pagesComplete && pageFiles.length <= DOC_LIMITS.pages
  };
  if (opts.find !== undefined) {
    const docs = await walkFiles(dir, 'siteorigin', (n) => n.endsWith('.json'), DOC_LIMITS.files, opts.signal);
    const manifest = await lstat(join(dir, 'siteorigin.project.json')).catch(() => null);
    const files = [...(manifest && !manifest.isSymbolicLink() ? [{ file: 'siteorigin.project.json', bytes: 0 }] : []), ...docs.files];
    const matches: DocMatch[] = [];
    const skipped = [...docs.skipped];
    let complete = docs.complete;
    // A manifest that is a link was not read: the search cannot say the text is not in it.
    if (manifest?.isSymbolicLink()) {
      complete = false;
      skipped.unshift('siteorigin.project.json (a link)');
    }
    let more = false;
    for (const f of files) {
      const { doc, why } = await readJson(f.file);
      if (doc === undefined) {
        // Anything not read leaves the search unable to say a text is not there.
        complete = false;
        skipped.push(`${f.file} (${why})`);
        continue;
      }
      if (findInJson(doc, opts.find, f.file, matches, DOC_LIMITS.matches)) {
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
  /** For a folder: how many files it holds (as far as counted), the first ones by path, and whether all were counted. */
  files?: number;
  listed?: { file: string; bytes: number }[];
  complete?: boolean;
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
  for (const k of Object.keys(a)) if (!['path', 'find', 'file', 'read'].includes(k)) throw new DriverError('BAD_REQUEST', `exports.inspect does not take "${k.slice(0, 100)}".`);
  if (typeof a.path !== 'string' || !a.path) throw new DriverError('BAD_REQUEST', '"path" is a session path in exports/, such as "exports/my-site-site".');
  if (a.find !== undefined && (typeof a.find !== 'string' || !a.find)) throw new DriverError('BAD_REQUEST', '"find" is the text to look for.');
  if (a.file !== undefined && (typeof a.file !== 'string' || !a.file || isAbsolute(a.file) || /^[A-Za-z]:/.test(a.file) || a.file.split(/[\\/]/).some((p) => p === '..' || p === '.'))) throw new DriverError('BAD_REQUEST', '"file" is a path inside the folder, such as "index.html".');
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

/**
 * Inspect what an export wrote into the session's exports folder: a file, or a folder (its files, one of them, or a
 * search of its text files for `find`). Read-only and bounded; links are never followed, on the way to the path asked
 * for either, and a listing or search that could not cover everything says so (`complete: false`).
 */
export async function inspectExport(areas: Record<Area, string>, args: InspectArgs, signal?: AbortSignal): Promise<ExportInspection> {
  const exportsRoot = areas.exports;
  const base = await resolveSessionPath(areas, args.path, ['exports']);
  const rel = relative(exportsRoot, base).split(sep).join('/');
  const logical = toSessionPath(areas, base) ?? args.path;
  // Named, it is the place it resolved to with no link on the way: an alias of another export is not inspected.
  const named = isAbsolute(args.path) ? resolve(args.path) : resolve(areas.exports, ...args.path.split(/[\\/]/).slice(1));
  if (named !== base || !(await noLinks(exportsRoot, rel))) throw new DriverError('BAD_REQUEST', `${args.path} leads through a link; only files the export wrote are inspected.`);
  const s = await lstat(base).catch(() => null);
  if (!s) throw new DriverError('TARGET_NOT_FOUND', `There is nothing at ${logical}.`, { details: { path: logical } });
  const one = async (fileRel: string, name: string): Promise<ExportInspection> => {
    const buf = await readPlain(exportsRoot, fileRel, EXPORT_LIMITS.fileBytes);
    if (buf === null) {
      const st = await lstat(join(exportsRoot, fileRel)).catch(() => null);
      if (!st) throw new DriverError('TARGET_NOT_FOUND', `There is no ${name} in ${logical}.`, { details: { path: logical, file: name } });
      throw new DriverError('BAD_REQUEST', `${name} is not a plain file the export wrote (a folder, or reached through a link).`);
    }
    if (buf === 'too-large') {
      const bytes = (await lstat(join(exportsRoot, fileRel)).catch(() => null))?.size;
      return { path: logical, type: 'file', ...(bytes !== undefined ? { bytes } : {}), ...(args.find !== undefined ? { find: { text: args.find, matches: [], more: false, searched: 0, complete: false, skipped: [`${name} (too large to read)`] } } : {}) };
    }
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
    return one(rel, logical.split('/').pop()!);
  }
  if (!s.isDirectory()) throw new DriverError('BAD_REQUEST', `${logical} is neither a file nor a folder.`);
  if (args.file !== undefined) {
    const inside = args.file.split(/[\\/]/).join('/');
    const inspected = await one(rel ? `${rel}/${inside}` : inside, inside);
    return { ...inspected, path: `${logical}/${inside}` };
  }
  const walked = await walkFiles(exportsRoot, rel, () => true, EXPORT_LIMITS.files, signal);
  const strip = (f: string) => (rel ? f.slice(rel.length + 1) : f);
  const files = walked.files.map((f) => ({ file: strip(f.file), bytes: f.bytes }));
  const skipped = walked.skipped.map(strip);
  const out: ExportInspection = { path: logical, type: 'folder', files: files.length, listed: files.slice(0, EXPORT_LIMITS.listed), complete: walked.complete };
  if (args.find !== undefined) {
    const matches: ExportMatch[] = [];
    const notRead: string[] = [...skipped];
    let complete = walked.complete;
    let searched = 0;
    let total = 0;
    let more = false;
    for (const f of files) {
      if (!TEXT_EXT.has(extname(f.file).toLowerCase())) continue;
      if (signal?.aborted) throw new DriverError('TIMEOUT', 'The request ran out of time.');
      const buf = total + f.bytes > EXPORT_LIMITS.totalBytes ? 'too-large' : await readPlain(exportsRoot, rel ? `${rel}/${f.file}` : f.file, EXPORT_LIMITS.fileBytes);
      if (buf === 'too-large' || buf === null) {
        complete = false;
        notRead.push(`${f.file} (${buf === null ? 'changed or reached through a link' : 'too large to read'})`);
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
    out.find = { text: args.find, matches, more, searched, complete, ...(notRead.length ? { skipped: notRead.slice(0, 20) } : {}) };
  } else if (skipped.length) out.skipped = skipped.slice(0, 20);
  return out;
}
