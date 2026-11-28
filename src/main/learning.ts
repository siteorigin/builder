import { realpathSync, statSync } from 'node:fs';
import { appendFile, mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { redact } from '@agent/types';
import type { ChatRecorder, ChatRecord } from '@agent/learning';
import { stableHash } from '@shared/ids';

/**
 * Learning mode (#1566): an opt-in recorder that writes every AI chat, step by step, to JSONL files on this computer,
 * for auditing chats and building training data. docs/learning-mode.md says what it records.
 *
 * Off unless SITEORIGIN_LEARNING turns it on at launch: no setting, menu item or default does. Files go to a folder
 * outside every project (SITEORIGIN_LEARNING_DIR, or `learning` in the app's user data), so nothing reaches a project,
 * an export, a commit or the live session relay, and nothing is uploaded.
 *
 * One file per conversation, named with the time it was first recorded and the conversation's ID, so files sort by time
 * and never collide. Every later step of that conversation is appended to it, in this launch or a later one: the folder
 * is searched for the conversation's file before a new one is made. Each launch's first write to a file is a header
 * with the labels, the app's version and commit, and the time. Files are only ever appended to: never rotated,
 * truncated, overwritten or deleted.
 *
 * A folder inside any Builder project is never written to: the recordings would be in that project, where an export
 * could carry them or clearing its chat history could delete them.
 *
 * A record is turned into its line as it is recorded, so a request whose items grow afterwards is kept as it was sent,
 * and the line is passed through `redact` so no API key reaches the file. Writes run one after another off the caller's
 * path: a run never waits on them, and a file that cannot be written is logged once and the chat goes on.
 */

/** The environment variables learning mode reads at launch. */
export const LEARNING_ENV = {
  on: 'SITEORIGIN_LEARNING',
  dir: 'SITEORIGIN_LEARNING_DIR',
  labels: 'SITEORIGIN_LEARNING_LABELS'
} as const;

export interface LearningConfig {
  dir: string;
  labels: Record<string, string>;
  /** What could not be read in the labels, each said as the log should say it. */
  problems: string[];
}

const ON = /^(1|true|yes|on)$/i;

/**
 * Labels as `key=value` pairs separated by commas: `experiment=sol-baseline,prompt=v3`. Spaces around each key and
 * value are dropped. A part with no `=` or no key cannot be read and is reported, as is a key given twice (the last
 * one is kept); the rest are kept either way.
 */
export function parseLearningLabels(raw: string | undefined): { labels: Record<string, string>; problems: string[] } {
  // No prototype: a key such as `__proto__` is a label like any other.
  const labels: Record<string, string> = Object.create(null);
  const problems: string[] = [];
  if (!raw?.trim()) return { labels, problems };
  for (const part of raw.split(',')) {
    if (!part.trim()) continue;
    const at = part.indexOf('=');
    const key = at < 0 ? '' : part.slice(0, at).trim();
    if (!key) {
      problems.push(`"${part.trim()}" is not a key=value pair, so it was left out.`);
      continue;
    }
    if (Object.hasOwn(labels, key)) problems.push(`"${key}" is given more than once, so its last value is kept.`);
    labels[key] = part.slice(at + 1).trim();
  }
  return { labels, problems };
}

/** Learning mode's settings from the environment, or null when it is off. `defaultDir` is used when no folder is named. */
export function readLearningConfig(env: Record<string, string | undefined>, defaultDir: string): LearningConfig | null {
  if (!ON.test(env[LEARNING_ENV.on]?.trim() ?? '')) return null;
  const named = env[LEARNING_ENV.dir]?.trim();
  const { labels, problems } = parseLearningLabels(env[LEARNING_ENV.labels]);
  return { dir: named ? resolve(named) : defaultDir, labels, problems: problems.map((p) => `${LEARNING_ENV.labels}: ${p}`) };
}

export interface LearningRecorderOptions {
  dir: string;
  labels: Record<string, string>;
  app: { name: string; version: string; commit: string | null };
  /** Where a file that cannot be written is reported, once. */
  warn: (message: string) => void;
  now?: () => Date;
}

/** A conversation's ID as it can stand in a file name: an ID with other characters is told apart by its hash. */
export function fileKey(conversationId: string): string {
  const safe = conversationId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80) || 'conversation';
  return safe === conversationId ? safe : `${safe}-${stableHash(conversationId)}`;
}

/** `2026-11-28T10:15:30.123Z` as `20261128T101530123Z`, which sorts as the time does and is a valid file name everywhere. */
const fileStamp = (d: Date) => d.toISOString().replace(/[-:.]/g, '');

/**
 * The file at the root of every Builder project (main/project/documents.ts MANIFEST_FILE): a folder with one in it or
 * above it is in a project.
 */
export const PROJECT_MARKER = 'siteorigin.project.json';

/** A path as the file system resolves it (symbolic links followed), as far as it exists: the rest as written. */
function realPath(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync.native(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(realPath(parent), basename(abs));
  }
}

/** The project folder that holds `path` (it, or a folder above it, is a Builder project), or null when none does. */
export function projectHolding(path: string): string | null {
  for (let at = realPath(path); ; ) {
    try {
      if (statSync(join(at, PROJECT_MARKER)).isFile()) return at;
    } catch {
      // Not a project here.
    }
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/** Whether `path` is `folder` or inside it, symbolic links followed. */
export function isWithin(path: string, folder: string): boolean {
  const rel = relative(realPath(folder), realPath(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** A folder learning mode will not write to, said as the log says it. */
class RefusedFolder extends Error {}

export class LearningRecorder implements ChatRecorder {
  /** The file each conversation is written to in this launch, once its header is written. */
  private files = new Map<string, string>();
  /** The conversation each run recorded in this launch belongs to, for an undo that names only the run. */
  private runs = new Map<string, string>();
  /** Conversations of a project that holds the folder, whatever it is marked with: never recorded. */
  private refused = new Set<string>();
  /** What was last recorded of each run's changes (undone or redone), so the same change is never recorded twice. */
  private standing = new Map<string, string>();
  /** Files whose last write failed, which may end part way through a line: the next write starts a line of its own. */
  private torn = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  /** What has been reported (the folder, or one file): each is reported once. */
  private warned = new Set<string>();
  private readonly now: () => Date;

  constructor(private readonly opts: LearningRecorderOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  get dir() {
    return this.opts.dir;
  }

  /** Records written or being written: none means nothing would be lost by quitting now. */
  get busy() {
    return this.pending > 0;
  }

  record(conversationId: string, record: ChatRecord): void {
    try {
      if (!conversationId || this.refused.has(conversationId)) return;
      // The chat's own project, as the run names it: refused even while it lacks the file that marks it a project.
      if (typeof record.project === 'string' && isWithin(this.opts.dir, record.project)) {
        this.refused.add(conversationId);
        this.fail(new RefusedFolder(`Learning mode does not write to ${this.opts.dir}: it is inside the project ${record.project}, and its recordings must stay outside every project. Chats go on unrecorded.`), this.opts.dir);
        return;
      }
      if (typeof record.runId === 'string') this.runs.set(record.runId, conversationId);
      const time = this.now();
      const line = this.line(conversationId, record, time);
      this.enqueue(() => this.write(conversationId, line, time));
    } catch (e) {
      // Recording never reaches the chat.
      this.fail(e, this.opts.dir);
    }
  }

  /**
   * Keep one step of the conversation run `runId` was in, such as an undo of its changes from History: found among the
   * runs recorded in this launch, or else in the folder's files. A run in no file is not recorded. It keeps its place
   * among the steps recorded after it, however long the search takes.
   */
  recordRun(runId: string, record: ChatRecord): void {
    try {
      // An undo or redo already recorded (two History changes that both saw it) is recorded once.
      if (record.type === 'undo' || record.type === 'redo') {
        if (this.standing.get(runId) === record.type) return;
        this.standing.set(runId, record.type);
      }
      const known = this.runs.get(runId);
      if (known) return this.record(known, { ...record, runId });
      const time = this.now();
      this.enqueue(async () => {
        const conversationId = this.runs.get(runId) ?? (await this.findRun(runId));
        if (!conversationId) return;
        this.runs.set(runId, conversationId);
        await this.write(conversationId, this.line(conversationId, { ...record, runId }, time), time);
      });
    } catch (e) {
      this.fail(e, this.opts.dir);
    }
  }

  /** Settles once everything recorded so far is written (or has failed to be). */
  async flush(): Promise<void> {
    // Work in the queue can add more, which is waited for too.
    for (let tail = this.queue; ; tail = this.queue) {
      await tail;
      if (tail === this.queue) return;
    }
  }

  /** A record's line, taken now: what it holds may change once the caller goes on. No API key survives it. */
  private line(conversationId: string, record: ChatRecord, time: Date): string {
    let line: string;
    try {
      line = JSON.stringify({ ...record, conversationId, time: time.toISOString() });
    } catch (e) {
      line = JSON.stringify({ type: 'unrecordable', step: record.type, error: String((e as Error)?.message ?? e), conversationId, time: time.toISOString() });
    }
    return redact(line);
  }

  private enqueue(work: () => Promise<void>) {
    this.pending++;
    this.queue = this.queue
      .then(work)
      .catch((e) => this.fail(e, (e as { learningFile?: string })?.learningFile ?? this.opts.dir))
      .finally(() => this.pending--);
  }

  /** The conversation of the file that names run `runId`, read from that file's own records. */
  private async findRun(runId: string): Promise<string | null> {
    const needle = `"runId":${JSON.stringify(runId)}`;
    const names = (await readdir(this.opts.dir, { withFileTypes: true }).catch(() => []))
      .filter((d) => d.isFile() && d.name.endsWith('.jsonl'))
      .map((d) => d.name)
      .sort()
      .reverse();
    for (const name of names) {
      const text = await readFile(join(this.opts.dir, name), 'utf8').catch(() => '');
      for (const line of text.split('\n')) {
        if (!line.includes(needle)) continue;
        try {
          // The run's own record, not a label or a message that happens to name it.
          const r = JSON.parse(line) as { runId?: unknown; conversationId?: unknown };
          if (r.runId === runId && typeof r.conversationId === 'string' && r.conversationId) return r.conversationId;
        } catch {
          // A line that cannot be read names nothing.
        }
      }
    }
    return null;
  }

  private async write(conversationId: string, line: string, time: Date) {
    const file = this.files.get(conversationId) ?? (await this.open(conversationId, time));
    await this.append(file, line);
  }

  /** Add one line to `file`, on a line of its own even when the last write to it failed part way. */
  private async append(file: string, line: string) {
    try {
      const after = this.torn.has(file) && !(await endsWithNewline(file).catch(() => true));
      await appendFile(file, `${after ? '\n' : ''}${line}\n`, { encoding: 'utf8', flag: 'a', mode: 0o600 });
      this.torn.delete(file);
    } catch (e) {
      this.torn.add(file);
      throw Object.assign(e as Error, { learningFile: file });
    }
  }

  /** The conversation's file, found or made, with this launch's header written to it. */
  private async open(conversationId: string, time: Date): Promise<string> {
    const { dir } = this.opts;
    // Looked for as each conversation's file is opened, so a folder that has come to be in a project since is refused.
    const holder = projectHolding(dir);
    if (holder) throw new RefusedFolder(`Learning mode does not write to ${dir}: it is inside the project ${holder}, and its recordings must stay outside every project. Chats go on unrecorded.`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const suffix = `-${fileKey(conversationId)}.jsonl`;
    // Only a file of the folder's own: never one a link points to elsewhere.
    const existing = (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isFile() && d.name.endsWith(suffix))
      .map((d) => d.name)
      .sort()[0];
    const file = join(dir, existing ?? `${fileStamp(time)}${suffix}`);
    try {
      // A new file is made only when none is there: `wx` never replaces one.
      if (!existing) await writeFile(file, '', { flag: 'wx', mode: 0o600 }).catch((e: NodeJS.ErrnoException) => (e.code === 'EEXIST' ? undefined : Promise.reject(e)));
      // One an earlier launch may have left part way through a line is looked at before it is added to.
      else this.torn.add(file);
      const { name, version, commit } = this.opts.app;
      const header = { type: 'header', conversationId, time: time.toISOString(), continued: !!existing, labels: this.opts.labels, app: { name, version, commit } };
      await this.append(file, redact(JSON.stringify(header)));
    } catch (e) {
      throw Object.assign(e as Error, { learningFile: file });
    }
    this.files.set(conversationId, file);
    return file;
  }

  private fail(e: unknown, key: string) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.report(e instanceof RefusedFolder ? e.message : `Learning mode could not write to ${key}: ${(e as Error)?.message ?? e}. Chats go on unrecorded where it cannot write.`);
  }

  private report(message: string) {
    try {
      this.opts.warn(message);
    } catch {
      // Reporting is best effort.
    }
  }
}

/** One History step as learning mode compares them (ProjectSession.historyInfo's entries). */
export interface HistoryStep {
  id: string;
  applied: boolean;
  /** The AI run whose changes the step is. */
  runId?: string;
  /** The AI run whose changes the step takes back on their own (a reviewed undo of one turn). */
  revertsRunId?: string;
}

/**
 * The AI runs whose changes a change of History took back or brought back, in the order History crossed their steps:
 * back from the newest, forward from the oldest. Crossing a run's own step undoes or redoes it; crossing a step that
 * took it back on its own does the opposite. A new step counts only when it is a reviewed undo, just made: a run's own
 * new step is a request that ended meanwhile, not a redo.
 */
export function historyChanges(before: HistoryStep[], after: HistoryStep[]): Array<{ type: 'undo' | 'redo'; runId: string }> {
  const was = new Map(before.map((s) => [s.id, s.applied]));
  const crossed = after.filter((s) => (was.has(s.id) ? was.get(s.id) !== s.applied : s.applied && !!s.revertsRunId));
  const back = crossed.some((s) => !s.applied);
  const out: Array<{ type: 'undo' | 'redo'; runId: string }> = [];
  for (const s of back ? crossed.reverse() : crossed) {
    if (s.runId) out.push({ type: s.applied ? 'redo' : 'undo', runId: s.runId });
    if (s.revertsRunId) out.push({ type: s.applied ? 'undo' : 'redo', runId: s.revertsRunId });
  }
  return out;
}

/** Whether a file is empty or ends a line: one that does not was cut off part way through its last line. */
async function endsWithNewline(file: string): Promise<boolean> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (!size) return true;
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    await handle.close();
  }
}
