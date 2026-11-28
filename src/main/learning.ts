import { realpathSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
 * A conversation of a project that holds the folder itself (a folder named inside a project) is never recorded: the
 * files would be in the project, where clearing its chat history could delete them.
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

/** Whether `path` is `folder` or inside it. */
export function isWithin(path: string, folder: string): boolean {
  const rel = relative(realPath(folder), realPath(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export class LearningRecorder implements ChatRecorder {
  /** The file each conversation is written to in this launch, once its header is written. */
  private files = new Map<string, string>();
  /** The conversation each run recorded in this launch belongs to, for an undo that names only the run. */
  private runs = new Map<string, string>();
  /** Conversations of projects that hold the folder: never recorded. */
  private refused = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private warned = false;
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
    if (!conversationId || this.refused.has(conversationId)) return;
    if (typeof record.project === 'string' && isWithin(this.opts.dir, record.project)) {
      this.refused.add(conversationId);
      this.report(`Learning mode does not record chats of ${record.project}: its folder ${this.opts.dir} is inside that project.`);
      return;
    }
    if (typeof record.runId === 'string') this.runs.set(record.runId, conversationId);
    const time = this.now();
    let line: string;
    try {
      line = JSON.stringify({ ...record, conversationId, time: time.toISOString() });
    } catch (e) {
      line = JSON.stringify({ type: 'unrecordable', step: record.type, error: String((e as Error)?.message ?? e), conversationId, time: time.toISOString() });
    }
    line = redact(line);
    this.enqueue(() => this.write(conversationId, line, time));
  }

  /**
   * Keep one step of the conversation run `runId` was in, such as an undo of its changes from History: found among the
   * runs recorded in this launch, or else in the folder's files. A run in no file is not recorded.
   */
  recordRun(runId: string, record: ChatRecord): void {
    const known = this.runs.get(runId);
    if (known) return this.record(known, { ...record, runId });
    this.enqueue(async () => {
      const conversationId = this.runs.get(runId) ?? (await this.findRun(runId));
      if (conversationId) this.record(conversationId, { ...record, runId });
    });
  }

  /** Settles once everything recorded so far is written (or has failed to be). */
  flush(): Promise<void> {
    return this.queue;
  }

  private enqueue(work: () => Promise<void>) {
    this.pending++;
    this.queue = this.queue
      .then(work)
      .catch((e) => this.fail(e))
      .finally(() => this.pending--);
  }

  /** The conversation of the file that names run `runId`, read from that file's own records. */
  private async findRun(runId: string): Promise<string | null> {
    const needle = `"runId":${JSON.stringify(runId)}`;
    let names: string[];
    try {
      names = (await readdir(this.opts.dir)).filter((n) => n.endsWith('.jsonl')).sort().reverse();
    } catch {
      return null;
    }
    for (const name of names) {
      const text = await readFile(join(this.opts.dir, name), 'utf8').catch(() => '');
      const line = text.split('\n').find((l) => l.includes(needle));
      if (!line) continue;
      try {
        const id = (JSON.parse(line) as { conversationId?: unknown }).conversationId;
        if (typeof id === 'string' && id) return id;
      } catch {
        // A line that cannot be read names nothing.
      }
    }
    return null;
  }

  private async write(conversationId: string, line: string, time: Date) {
    const file = this.files.get(conversationId) ?? (await this.open(conversationId, time));
    await appendFile(file, `${line}\n`, { encoding: 'utf8', flag: 'a', mode: 0o600 });
  }

  /** The conversation's file, found or made, with this launch's header written to it. */
  private async open(conversationId: string, time: Date): Promise<string> {
    const { dir } = this.opts;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const suffix = `-${fileKey(conversationId)}.jsonl`;
    const existing = (await readdir(dir)).filter((n) => n.endsWith(suffix)).sort()[0];
    const file = join(dir, existing ?? `${fileStamp(time)}${suffix}`);
    // A new file is made only when none is there: `wx` never replaces one.
    if (!existing) await writeFile(file, '', { flag: 'wx', mode: 0o600 }).catch((e: NodeJS.ErrnoException) => (e.code === 'EEXIST' ? undefined : Promise.reject(e)));
    const { name, version, commit } = this.opts.app;
    const header = { type: 'header', conversationId, time: time.toISOString(), continued: !!existing, labels: this.opts.labels, app: { name, version, commit } };
    await appendFile(file, `${redact(JSON.stringify(header))}\n`, { encoding: 'utf8', flag: 'a', mode: 0o600 });
    this.files.set(conversationId, file);
    return file;
  }

  private fail(e: unknown) {
    if (this.warned) return;
    this.warned = true;
    this.report(`Learning mode could not write to ${this.opts.dir}: ${(e as Error)?.message ?? e}. Chats go on unrecorded where it cannot write.`);
  }

  private report(message: string) {
    try {
      this.opts.warn(message);
    } catch {
      // Reporting is best effort.
    }
  }
}
