/**
 * The record a session keeps of what was done in it, and the evidence it leaves (issue #497): an ordered journal of
 * every request, classed as setup, input, observation or session management; a bounded copy of the app's own output;
 * and a replay record (build, scenario, steps with targets a fresh session can find again, the last observation and
 * the artifacts) that a person reads after a failure and a fresh session can replay (replay.ts).
 *
 * Everything here is bounded: the journal keeps a number of entries and of bytes and counts what it let go, a value in
 * an entry is cut to length, and the app's output keeps its beginning and its end. Everything a session hands out
 * from here is scrubbed of the credentials it knows, and its host paths are shown relative to the session, the
 * checkout and the home folder, or hidden.
 */
import { homedir, tmpdir } from 'node:os';
import type { OpKind, XY } from './protocol.ts';
import { REDACTED, scrubber } from './snapshot.ts';
import type { Scope } from './snapshot.ts';

/** What a journal entry records about the request: whether a person could have done it, and if so what. */
export type EntryClass = 'setup' | 'input' | 'observation' | 'session';

export const CLASS_OF: Record<OpKind, EntryClass> = { fixture: 'setup', act: 'input', observe: 'observation', session: 'session' };

/**
 * How a replay finds an input's target again in a new session: the role, name and region it had (from the search that
 * found it, or what the observation saw), and the point inside it. A screenshot point names pixels of one run and has
 * no description to find it by.
 */
export interface TargetDescriptor {
  /** Where in the request's args the target was: `target`, `from` or `to`. */
  at: 'target' | 'from' | 'to';
  scope?: Scope;
  role?: string;
  name?: string;
  /** False: the name was a case-insensitive part of the element's name. */
  exact?: boolean;
  region?: string;
  position?: XY;
  replayable: boolean;
  /** Why it is not replayable. */
  reason?: string;
}

export interface EntryOutcome {
  ok: boolean;
  /** The error's code, for a failure. */
  code?: string;
  message?: string;
  /** For an input that failed: whether any of it was sent ('none', 'partial'). */
  dispatched?: string;
  /** A few facts from the reply: what an input reached, what a wait matched, what an assertion found. */
  summary?: Record<string, unknown>;
}

export interface JournalEntry {
  /** Counts the session's requests from 1, in the order they were admitted. */
  seq: number;
  id: string;
  op: string;
  class: EntryClass;
  /** When it was admitted, in ms from the session's creation. */
  t: number;
  /** The editor window generation it ran against, when there was one. */
  window: number | null;
  /** The request's args, cut to length; typed text or a key that may be a credential is left out (`textLeftOut`, `keyLeftOut`). */
  args?: Record<string, unknown>;
  /** The deadline the request asked for, so a replay gives it the same. */
  timeoutMs?: number;
  targets?: TargetDescriptor[];
  outcome?: EntryOutcome;
  elapsedMs?: number;
  /** Set when a replay cannot repeat this step, and why. */
  unreplayable?: string;
}

/** Limits on a value kept in a journal entry or an evidence record. */
export const CLIP = { string: 300, items: 50, depth: 6, keys: 40 };
/** The longest key kept whole. */
const KEY_CHARS = 100;

/**
 * A copy of a JSON value cut to the limits: long strings and keys, long lists, deep nesting and wide objects are
 * shortened. A string cut short ends in `…` (scrubText checks that end for part of a credential).
 */
export function clipJson(v: unknown, limits = CLIP, depth = 0, cut?: { cut: boolean }): unknown {
  const mark = () => {
    if (cut) cut.cut = true;
  };
  if (typeof v === 'string') return v.length > limits.string ? (mark(), `${v.slice(0, limits.string)}…`) : v;
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (v === undefined || typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') return undefined;
  if (depth >= limits.depth) return mark(), '…';
  if (Array.isArray(v)) {
    const out = v.slice(0, limits.items).map((x) => clipJson(x, limits, depth + 1, cut));
    if (v.length > limits.items) {
      mark();
      out.push(`… ${v.length - limits.items} more`);
    }
    return out;
  }
  const entries = Object.entries(v as Record<string, unknown>);
  const out: Record<string, unknown> = {};
  for (const [k, x] of entries.slice(0, limits.keys)) {
    const c = clipJson(x, limits, depth + 1, cut);
    if (k.length > KEY_CHARS) mark();
    if (c !== undefined) out[k.length > KEY_CHARS ? `${k.slice(0, KEY_CHARS)}…` : k] = c;
  }
  if (entries.length > limits.keys) {
    mark();
    out['…'] = `${entries.length - limits.keys} more keys`;
  }
  return out;
}

const sizeOf = (e: JournalEntry) => JSON.stringify(e).length;

/**
 * The session's requests in the order they were admitted. Bounded by entries and by characters: the oldest go first,
 * and how many went is reported, so a reader always knows whether it has the whole run.
 */
export class Journal {
  readonly limit: number;
  readonly maxChars: number;
  private readonly list: JournalEntry[] = [];
  private seq = 0;
  private chars = 0;
  private droppedCount = 0;
  private readonly sizes = new Map<JournalEntry, number>();

  constructor(limit = 500, maxChars = 512 * 1024) {
    this.limit = limit;
    this.maxChars = maxChars;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  get last(): number {
    return this.seq;
  }

  /** Admit a request: it gets the next number now, whatever happens to it. */
  admit(e: Omit<JournalEntry, 'seq'>): JournalEntry {
    const entry: JournalEntry = { seq: ++this.seq, ...e };
    this.list.push(entry);
    this.measure(entry);
    return entry;
  }

  /** Record how an admitted request ended. */
  finish(entry: JournalEntry, outcome: EntryOutcome, elapsedMs: number) {
    entry.outcome = clipJson(outcome) as EntryOutcome;
    entry.elapsedMs = elapsedMs;
    this.measure(entry);
  }

  /** Re-count an entry after it changed, and let the oldest go while the journal is over its limits. */
  measure(entry: JournalEntry) {
    if (!this.list.includes(entry)) return;
    this.chars -= this.sizes.get(entry) ?? 0;
    let size = sizeOf(entry);
    // One entry never takes more than a quarter of the journal: past that, what it asked for is left out.
    if (size > this.maxChars / 4) {
      entry.args = { leftOut: `${size} characters, too large to keep` };
      delete entry.targets;
      if (entry.outcome) entry.outcome = { ok: entry.outcome.ok, ...(entry.outcome.code ? { code: entry.outcome.code } : {}) };
      entry.unreplayable = 'what it asked for was too large to keep';
      size = sizeOf(entry);
    }
    this.sizes.set(entry, size);
    this.chars += size;
    while (this.list.length > this.limit || (this.chars > this.maxChars && this.list.length > 1)) {
      const old = this.list.shift()!;
      this.chars -= this.sizes.get(old) ?? 0;
      this.sizes.delete(old);
      this.droppedCount++;
    }
  }

  /** Entries after `after` (a seq) and before `before`, at most `limit` of them, and where to continue. */
  read(after = 0, limit = 100, before = Infinity): { entries: JournalEntry[]; next: number; dropped: number; first: number | null; last: number } {
    const entries = this.list.filter((e) => e.seq > after && e.seq < before).slice(0, limit);
    return { entries, next: entries.length ? entries[entries.length - 1].seq : after, dropped: this.droppedCount, first: this.list[0]?.seq ?? null, last: this.seq };
  }

  entries(): JournalEntry[] {
    return [...this.list];
  }
}

// ---------------------------------------------------------------------------
// Host paths
// ---------------------------------------------------------------------------

export interface PathRoot {
  path: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** The least of a credential that is taken for part of it where a string was cut. */
const PART = 4;

/**
 * A string with every known credential replaced, including the part of one left where the string was cut to length
 * (an end marked `…`): a credential that became known after the string was cut cannot be matched whole.
 */
export function scrubText(s: string, secrets: string[]): string {
  const list = secrets.filter((x) => !!x);
  if (!list.length) return s;
  let out = scrubber(list)(s);
  const tailCut = out.endsWith('…');
  const headCut = out.startsWith('…');
  if (!tailCut && !headCut) return out;
  let body = out.slice(headCut ? 1 : 0, tailCut ? -1 : undefined);
  for (const x of list) {
    if (x.length <= PART) continue;
    if (tailCut)
      for (let k = Math.min(x.length - 1, body.length); k >= PART; k--)
        if (body.endsWith(x.slice(0, k))) {
          body = body.slice(0, body.length - k) + REDACTED;
          break;
        }
    if (headCut)
      for (let k = Math.min(x.length - 1, body.length); k >= PART; k--)
        if (body.startsWith(x.slice(x.length - k))) {
          body = REDACTED + body.slice(k);
          break;
        }
  }
  out = `${headCut ? '…' : ''}${body}${tailCut ? '…' : ''}`;
  return out;
}

/**
 * A copy of a JSON value with every string scrubbed (scrubText), whatever its key; with `keys`, the keys too (for what a
 * caller sent, whose keys are theirs: the driver's own keys are never renamed by a short credential).
 */
export function scrubAll<T>(v: T, secrets: string[], keys = false): T {
  if (!secrets.some((x) => !!x)) return v;
  const visit = (x: unknown): unknown => {
    if (typeof x === 'string') return scrubText(x, secrets);
    if (Array.isArray(x)) return x.map(visit);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [keys ? scrubText(k, secrets) : k, visit(y)]));
    return x;
  };
  return visit(v) as T;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The ways a folder can appear in text: as it is, with forward slashes, as a file URL, percent-encoded. */
function forms(path: string): string[] {
  const p = path.replace(/[\\/]+$/, '');
  if (!p) return [];
  const out = new Set<string>([p]);
  const forward = p.replace(/\\/g, '/');
  out.add(forward);
  // macOS reports temporary folders both through /private and without it.
  if (forward.startsWith('/private/')) out.add(forward.slice('/private'.length));
  for (const f of [...out]) {
    out.add(encodeURI(f));
    out.add(`file://${f.startsWith('/') ? '' : '/'}${f}`);
    out.add(`file://${f.startsWith('/') ? '' : '/'}${encodeURI(f)}`);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/**
 * Absolute paths of the host, wherever they appear in text: what is left once the known folders have been named.
 * - A path starts where a word does not, so `exports/site/home/index.html` is not one.
 * - Any path into a folder at the top of macOS's disk that holds people's and programs' files (Users, Volumes, ...).
 * - A path into a Unix folder whose name a site's own page could also have (home, media, var, ...) only two folders
 *   down, so a route such as `/about/` or `/media/` is not one.
 * - A Windows drive path, and a network (UNC) path.
 */
const HOST_PATH =
  /(?<![\w.~/\\-])(?:file:\/\/)?(?:\/(?:Users|Volumes|Library|Applications|System|private)(?=[\\/]|$)[^\s'"`<>|()]*|\/(?:home|var|tmp|opt|root|mnt|media|srv|etc|usr|nix|snap|run)\/[^\s'"`<>|()/\\]+\/[^\s'"`<>|()/\\]+[^\s'"`<>|()]*|[A-Za-z]:[\\/][^\s'"`<>|()]*|\\\\[^\s'"`<>|()\\]+\\[^\s'"`<>|()]*)/g;
/** A dev server's file URL (`/@fs/Users/...`) carries a host path right after it. */
const FS_URL = /(\/@fs)\/(?:Users|Volumes|private|home|var|tmp|opt|root|mnt|media|srv|usr|[A-Za-z]:)[^\s'"`<>|()]*/g;

export const HOST_PATH_LABEL = '<host-path>';

/**
 * A function that names each known folder by its label wherever text mentions it (longer folders first, so the
 * session's folder inside the temporary folder gets the session's label), then hides any other absolute path of the
 * host. Applied to everything a replay record or a wait's evidence holds.
 */
export function pathHider(roots: PathRoot[]): (text: string) => string {
  const known = roots
    .filter((r) => !!r.path)
    .flatMap((r) => forms(r.path).map((f) => ({ f, label: r.label })))
    .sort((a, b) => b.f.length - a.f.length);
  const compiled = known.map(({ f, label }) => ({ re: new RegExp(`${escapeRegExp(f)}(?=$|[\\\\/\\s'"\`<>|:;,)\\]}?#])`, 'g'), label }));
  return (text: string) => {
    let out = text;
    for (const { re, label } of compiled) out = out.replace(re, label);
    return out.replace(FS_URL, `$1/${HOST_PATH_LABEL}`).replace(HOST_PATH, HOST_PATH_LABEL);
  };
}

/** The folders every session's evidence names by label: the home and temporary folders of this machine. */
export function machineRoots(): PathRoot[] {
  const roots: PathRoot[] = [];
  const tmp = tmpdir();
  if (tmp) roots.push({ path: tmp, label: '<tmp>' });
  const home = homedir();
  if (home && home !== '/') roots.push({ path: home, label: '~' });
  return roots;
}

/** A copy of a JSON value with every string passed through `hide`. */
export function hideDeep<T>(v: T, hide: (s: string) => string): T {
  const visit = (x: unknown): unknown => {
    if (typeof x === 'string') return hide(x);
    if (Array.isArray(x)) return x.map(visit);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [hide(k), visit(y)]));
    return x;
  };
  return visit(v) as T;
}

// ---------------------------------------------------------------------------
// The app's output
// ---------------------------------------------------------------------------

/**
 * The app's stdout and stderr, bounded: its first `headChars` characters and its last `tailChars`, with how much was
 * left out between them. A session that runs for hours keeps a log of the same size as one that runs for a minute.
 */
export class LogKeeper {
  private head = '';
  private tail = '';
  private leftOut = 0;
  readonly headChars: number;
  readonly tailChars: number;

  constructor(headChars = 512 * 1024, tailChars = 512 * 1024) {
    this.headChars = headChars;
    this.tailChars = tailChars;
  }

  /** How many characters have been written in all. */
  written = 0;

  write(chunk: Buffer | string) {
    let s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this.written += s.length;
    if (this.head.length < this.headChars) {
      const room = this.headChars - this.head.length;
      this.head += s.slice(0, room);
      s = s.slice(room);
    }
    if (!s) return;
    this.tail += s;
    if (this.tail.length > this.tailChars) {
      const cut = this.tail.length - this.tailChars;
      this.leftOut += cut;
      this.tail = this.tail.slice(cut);
    }
  }

  /**
   * The kept output, with `clean` applied to each kept part: a part cut where output was left out is passed with `…`
   * at that end, so a credential cut there is still caught (scrubText).
   */
  text(clean?: (s: string) => string): string {
    if (!this.leftOut) return clean ? clean(this.head + this.tail) : this.head + this.tail;
    if (!clean) return `${this.head}\n… ${this.leftOut} characters of output left out …\n${this.tail}`;
    return `${clean(`${this.head}…`)}\n… ${this.leftOut} characters of output left out …\n${clean(`…${this.tail}`)}`;
  }

  /** The last `n` lines that read as trouble, newest last, each cut to length. */
  troubles(n = 8, max = 300): string[] {
    const lines = (this.tail || this.head).split(/\r?\n/);
    const out: string[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
      const l = lines[i].trim();
      if (l && TROUBLE.test(l)) out.unshift(l.length > max ? `${l.slice(0, max)}…` : l);
    }
    return out;
  }
}

const TROUBLE = /\b[A-Za-z]*Error\b|\b(?:error|failed|failure|cannot|can't|could not|unhandled|exception|fatal|refused|crash(?:ed)?)\b/i;

// ---------------------------------------------------------------------------
// The replay record
// ---------------------------------------------------------------------------

export const REPLAY_KIND = 'siteorigin-driver-replay';
export const REPLAY_VERSION = 1;

export interface ReplayRecord {
  kind: typeof REPLAY_KIND;
  version: typeof REPLAY_VERSION;
  savedAt: string;
  /** The build the steps ran against, and the checkout it sits in. */
  build: { fingerprint: string; files: number; builtAt: string; packageVersion: string | null; git: { head: string; dirty: boolean } | null } | null;
  platform: { os: string; arch: string; electron: string | null; chrome: string | null };
  /** How the session started: the fixture project and the AI provider's scenario. */
  scenario: { fixture: string; provider: 'scripted' | 'none' };
  /** Every request the journal still holds, in order. */
  steps: JournalEntry[];
  /** Entries the journal let go for space: a replay of a record that lost its first steps starts mid-run. */
  dropped: number;
  complete: boolean;
  evidence: {
    /** The last observation: its context and a bounded tree. */
    observation: unknown;
    /** Screenshots saved with it, as paths inside the artifacts folder; absent when withheld (`withheld` says why). */
    screenshots?: { editor?: string; preview?: string; withheld?: string };
    /** The last request that failed, and how. */
    failure: unknown;
    /** The latest page errors the editor raised, and how many there were in all. */
    pageErrors: { total: number; latest: string[] };
    /** The latest lines of the app's output that read as trouble. */
    log: string[];
  };
  /** The files in the artifacts folder, by name. */
  artifacts: string[];
}
