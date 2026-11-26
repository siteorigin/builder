/**
 * Memory readings for the benchmark (scripts/perf/README.md, "Memory"). The harness takes them, never the app: a
 * reading lists every process the app owns, by role (main, editor, preview, gpu, devServer, media, …), with the memory
 * the OS says it holds (its physical footprint on macOS, `ps` RSS on Linux, the working set on Windows), the JavaScript
 * heap in use of the main process and the editor, the number of processes and their total.
 *
 * A reading at rest is taken once the app's processes have stopped changing and garbage has been collected in the main
 * process, the editor and the preview's frame. A peak samples the process table through a stretch of work and keeps the
 * highest total, and the highest figure of each role. Neither is ever taken inside a timed window, and nothing is read
 * or collected unless a scenario asks for it: an iteration without a memory scenario never makes a probe.
 */
import { execFile } from 'node:child_process';
import type { ElectronApplication, Frame, Page } from 'playwright';
import { ownedEntries, type ProcessEntry } from '../../tests/driver/processes';
import type { Collector } from './results';

/** Raised whenever the way a reading is taken changes (waits, collections, the source): results of different protocols are never compared. */
export const MEMORY_PROTOCOL = 2;

/** How a reading at rest waits and collects: written into every reading, so the result says how it was taken. */
export const REST = {
  /** Left alone first, for work a step set off after its check passed (a thumbnail, a workspace save, an idle helper). */
  settleMs: 3000,
  /** Two process tables this far apart that list the same processes are a settled set. */
  stableGapMs: 500,
  /** The longest a reading waits, over all its attempts, for the processes to hold still; a set that never does fails it. */
  stableMaxMs: 15_000,
  /** Garbage is collected twice in each process, then left this long before the sample. */
  gcPasses: 2,
  postGcMs: 1000,
  /** Samples whose processes differ from the settled set are taken again, at most this many times. */
  retries: 3
};
/** How often a peak samples the process table. A process that lives for less than this can go unseen. */
export const PEAK_PERIOD_MS = 200;

// ---------------------------------------------------------------------------
// The process table, with each process's memory
// ---------------------------------------------------------------------------

/** One process of the machine, with the memory the OS says it holds, in bytes, and its executable (never its arguments). */
export interface MemoryRow extends ProcessEntry {
  bytes: number;
  command: string;
}

/**
 * Where each process's memory is read from on this platform. On macOS its physical footprint, as `top` and Activity
 * Monitor give it: RSS there counts pages a process has handed back until the system takes them, and leaves out pages
 * it has compressed, so it moves with the machine's memory pressure (two runs of one build moved by a third).
 */
export const memorySource = (platform: NodeJS.Platform = process.platform) => (platform === 'win32' ? 'CIM WorkingSetSize' : platform === 'darwin' ? 'top footprint' : 'ps rss');

const POSIX_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.*?)\s*$/;
const WINDOWS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*?)\s*$/;

/**
 * Parse `ps -A -o pid=,ppid=,pgid=,rss=,lstart=,comm=` (RSS in KiB; the start time as five words, as
 * tests/driver/processes.ts keeps it), or the Windows listing (`pid ppid bytes ticks name`). Other lines are skipped.
 */
export function parseMemoryTable(text: string, platform: NodeJS.Platform = process.platform): MemoryRow[] {
  const out: MemoryRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (platform === 'win32') {
      const w = WINDOWS_ROW.exec(line);
      if (w) out.push({ pid: Number(w[1]), ppid: Number(w[2]), bytes: Number(w[3]), started: w[4], command: w[5] });
      continue;
    }
    const p = POSIX_ROW.exec(line);
    if (p) out.push({ pid: Number(p[1]), ppid: Number(p[2]), pgid: Number(p[3]), bytes: Number(p[4]) * 1024, started: p[5].split(/\s+/).join(' '), command: p[6] });
  }
  return out;
}

const UNITS: Record<string, number> = { B: 1, K: 2 ** 10, M: 2 ** 20, G: 2 ** 30, T: 2 ** 40 };

/** Each process's footprint from `top -l 1 -s 0 -stats pid,mem` (macOS), in bytes: `3248K`, `735M`, with `+`/`-` marks
 *  on the figure and `*`/`-` on the pid. */
export function parseFootprints(text: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)[*-]?\s+(\d+(?:\.\d+)?)([BKMGT])[+-]?\s*$/.exec(line);
    if (m) out.set(Number(m[1]), Math.round(Number(m[2]) * UNITS[m[3]]));
  }
  return out;
}

/**
 * `rows` with each process's footprint in place of its RSS. A process `top` did not list (one that started between the
 * two) keeps every row it has, for who is whose, and NaN: a sample with one is incomplete, and is taken again (at rest)
 * or left out of a peak.
 */
export function withFootprints(rows: MemoryRow[], footprints: Map<number, number>): MemoryRow[] {
  // A zombie (RSS 0, gone from top's tasks until its parent reaps it) holds nothing.
  return rows.map((r) => ({ ...r, bytes: footprints.get(r.pid) ?? (r.bytes === 0 ? 0 : NaN) }));
}

/** Whether a sample has processes, and every one of them its figure. */
export const complete = (rows: MemoryRow[]) => rows.length > 0 && rows.every((r) => Number.isFinite(r.bytes));

const run = (file: string, args: string[], timeoutMs: number) =>
  new Promise<string>((resolve, reject) => execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout))));

// Creation times in UTC ticks, as tests/driver/processes.ts reads them.
const WIN_MEMORY = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.WorkingSetSize) $($_.CreationDate.ToUniversalTime().Ticks) $($_.Name)" }';

/** This machine's process table with each process's memory (memorySource). Throws when it cannot be read. */
export async function memoryTable(timeoutMs = 10_000): Promise<MemoryRow[]> {
  if (process.platform === 'win32') return nonEmpty(parseMemoryTable(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_MEMORY], timeoutMs)));
  const ps = run('ps', ['-A', '-o', 'pid=,ppid=,pgid=,rss=,lstart=,comm='], timeoutMs);
  if (process.platform !== 'darwin') return nonEmpty(parseMemoryTable(await ps));
  // Who is whose from ps, what each holds from top, read at the same time.
  const [table, top] = await Promise.all([ps, run('top', ['-l', '1', '-s', '0', '-stats', 'pid,mem'], timeoutMs)]);
  return nonEmpty(withFootprints(parseMemoryTable(table), parseFootprints(top)));
}

function nonEmpty(rows: MemoryRow[]): MemoryRow[] {
  if (!rows.length) throw new Error('The process table came back empty.');
  return rows;
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/** What the app says about its processes and windows at one moment (electronSource reads it). */
export interface AppFacts {
  /** The Electron main process (not a shell Playwright may have launched it through). */
  main: number;
  /** The editor window's renderer. */
  editor: number | null;
  /** The renderer of the canvas's preview frame, when a project is open and the frame has its own. */
  preview: number | null;
  /** Every other window's renderer: the thumbnails' hidden window is the one that cannot take focus. */
  windows: Array<{ pid: number; focusable: boolean }>;
  /** `app.getAppMetrics()`: Electron's type, a utility process's service or name, and when it was created (epoch ms). */
  processes: Array<{ pid: number; type: string; label: string | null; created?: number | null }>;
}

const camel = (s: string) =>
  s
    .trim()
    .replace(/\.(app|exe)$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : ''));

/** The app's own utility processes, by the service name they are forked with ("SiteOrigin …"). */
const HELPERS: Record<string, string> = { 'project runtime': 'devServer', 'project build': 'projectBuild', media: 'media', 'import reader': 'importReader', 'source sync': 'sourceSync' };

/** A utility process's role, from its service name: the app's helpers by what they are, Chromium's by their service. */
export function utilityRole(label: string | null): string {
  if (!label) return 'utility';
  const ours = /^SiteOrigin (.+)$/.exec(label);
  if (ours) return HELPERS[ours[1].toLowerCase()] ?? camel(ours[1]);
  const service = /^([A-Za-z_]+)\.mojom\./.exec(label);
  if (service) return camel(service[1]);
  return camel(label) || 'utility';
}

/** A process Electron lists, by its type alone (the editor, preview and windows are told apart before this). */
export function electronRole(p: { type: string; label: string | null }): string {
  if (p.type === 'Browser') return 'main';
  if (p.type === 'GPU') return 'gpu';
  if (p.type === 'Tab') return 'renderer';
  if (p.type === 'Utility') return utilityRole(p.label);
  return camel(p.type) || 'unknown';
}

/**
 * What the app said each process was, keyed by process identity (pid and start time), merged over the moments it was
 * asked: a process keeps the last role it was seen in. Keying by identity keeps a pid the OS gave to a later process
 * (Windows reuses them soon) from inheriting the earlier one's role.
 */
export interface RoleFacts {
  main: number;
  editor: Set<string>;
  preview: Set<string>;
  windows: Map<string, boolean>;
  processes: Map<string, { type: string; label: string | null }>;
}

/** .NET ticks at the Unix epoch, and how far the OS's start time may be from Electron's creation time (POSIX gives seconds). */
const EPOCH_TICKS = 621355968000000000n;
const START_SLACK_MS = 2000;

/** When a row's process started, epoch ms: `ps` gives local time to the second, Windows UTC ticks; null if unknown. */
export function startedMs(r: ProcessEntry): number | null {
  if (!r.started) return null;
  if (/^\d+$/.test(r.started)) return Number((BigInt(r.started) - EPOCH_TICKS) / 10000n);
  const t = Date.parse(r.started);
  return Number.isFinite(t) ? t : null;
}

/**
 * Each answer of the app's, with the processes the tables read beside it had under each pid. What the answer says of a
 * pid goes to the one of those processes that started when Electron says its process was created; when none did, or
 * several could have (a pid given to a new process within the time the OS gives starts to), it goes to none.
 */
export function mergeFacts(all: Array<{ facts: AppFacts; rows: MemoryRow[] }>): RoleFacts {
  const out: RoleFacts = { main: all[0]?.facts.main ?? -1, editor: new Set(), preview: new Set(), windows: new Map(), processes: new Map() };
  for (const { facts: f, rows } of all) {
    const byPid = new Map<number, Map<string, MemoryRow>>();
    for (const r of rows) byPid.set(r.pid, (byPid.get(r.pid) ?? new Map()).set(identity(r), r));
    const created = new Map(f.processes.map((p) => [p.pid, p.created ?? null]));
    const at = (pid: number | null) => {
      const made = pid === null ? null : (created.get(pid) ?? null);
      const fits = [...(pid === null ? [] : (byPid.get(pid)?.values() ?? []))].filter((r) => {
        const started = startedMs(r);
        return made === null || started === null || Math.abs(made - started) <= START_SLACK_MS;
      });
      return fits.length === 1 ? identity(fits[0]) : undefined;
    };
    if (at(f.editor)) out.editor.add(at(f.editor)!);
    if (at(f.preview)) out.preview.add(at(f.preview)!);
    for (const w of f.windows) if (at(w.pid)) out.windows.set(at(w.pid)!, w.focusable);
    for (const p of f.processes) if (at(p.pid)) out.processes.set(at(p.pid)!, { type: p.type, label: p.label });
  }
  return out;
}

const identity = (r: ProcessEntry) => `${r.pid}@${r.started ?? ''}`;
const executable = (command: string) => command.split(/[\\/]/).pop() ?? command;

/** One process of a reading: what it is, and what it holds. The pid is kept only to tell two of one role apart. */
export interface ProcessMemory {
  role: string;
  bytes: number;
  pid: number;
}

/**
 * Each of `rows` (the app's processes) with its role. The editor, the preview's frame and the other windows come from
 * the windows' own renderers; anything else Electron lists by its type and service; a process Electron does not list
 * (one a helper started) as its parent's role and its executable, `devServer.esbuild`, or `main.unlisted` for one the
 * app's own executable runs (npm while it installs a project's tools, or on Windows, where every Chromium helper runs
 * that executable, a helper Electron has not reported yet). A renderer that no longer holds what it was seen holding
 * (the preview's, which Chromium keeps a few seconds after the frame goes) keeps that role, through `remembered`.
 */
export function attributeRows(rows: MemoryRow[], facts: RoleFacts, remembered: Map<string, string> = new Map()): Array<{ row: MemoryRow; role: string }> {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const appExe = executable(byPid.get(facts.main)?.command ?? '');
  const roles = new Map<number, string>();
  const roleOf = (row: MemoryRow, depth = 0): string => {
    const known = roles.get(row.pid);
    if (known) return known;
    const id = identity(row);
    let role: string;
    if (row.pid === facts.main) role = 'main';
    else if (facts.editor.has(id)) role = 'editor';
    else if (facts.preview.has(id)) role = 'preview';
    else if (facts.windows.has(id)) role = facts.windows.get(id) ? 'window' : 'thumbnails';
    else if (facts.processes.has(id)) {
      const r = electronRole(facts.processes.get(id)!);
      role = r === 'renderer' ? (remembered.get(id) ?? r) : r;
    } else if (remembered.has(id)) role = remembered.get(id)!;
    else {
      const parent = byPid.get(row.ppid);
      const exe = executable(row.command);
      const name = appExe && exe === appExe ? 'unlisted' : camel(exe) || 'process';
      role = `${parent && depth < 8 ? roleOf(parent, depth + 1) : 'orphan'}.${name}`;
    }
    roles.set(row.pid, role);
    remembered.set(id, role);
    return role;
  };
  return rows.map((row) => ({ row, role: roleOf(row) }));
}

const byRoleThenPid = (a: ProcessMemory, b: ProcessMemory) => a.role.localeCompare(b.role) || a.pid - b.pid;

/** `rows` as a reading's processes, by role. */
export function attribute(rows: MemoryRow[], facts: RoleFacts, remembered: Map<string, string> = new Map()): ProcessMemory[] {
  return attributeRows(rows, facts, remembered)
    .map(({ row, role }) => ({ role, bytes: row.bytes, pid: row.pid }))
    .sort(byRoleThenPid);
}

/** Each role's process count and resident bytes. */
export function byRole(processes: ProcessMemory[]): Record<string, { processes: number; bytes: number }> {
  const out: Record<string, { processes: number; bytes: number }> = {};
  for (const p of processes) {
    const r = (out[p.role] ??= { processes: 0, bytes: 0 });
    r.processes++;
    r.bytes += p.bytes;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Readings
// ---------------------------------------------------------------------------

export interface RestHow {
  source: string;
  protocol: number;
  /** From asking to the sample, and the part of it (every attempt's) spent waiting for the processes to settle. */
  waitedMs: number;
  settledMs: number;
  /** The processes whose garbage was collected, and how many times. */
  collected: string[];
  gcPasses: number;
  postGcMs: number;
  retries: number;
}

export interface PeakHow {
  source: string;
  protocol: number;
  periodMs: number;
  samples: number;
  /** The longest time between two samples: what may have gone unseen. */
  maxGapMs: number;
  /** From the first sample to the last. */
  durationMs: number;
  /** Samples left out because a process in them had no figure (macOS: one `top` had not listed yet). */
  incomplete: number;
}

/**
 * One reading. At rest: each process at the sample, each role's sum, the total and count, and the heaps. A peak: each
 * process at its own highest, each role's highest sum and count, and the highest total and count, each over the samples
 * (the highest total is never the sum of the roles' highest: they need not come at once).
 */
export interface MemoryReading {
  label: string;
  kind: 'rest' | 'peak';
  /** When the sample (at rest) or the first sample (a peak) was taken, epoch ms. */
  at: number;
  processes: ProcessMemory[];
  roles: Record<string, { processes: number; bytes: number }>;
  total: number;
  count: number;
  /** The JavaScript heap in use, bytes (at rest only). */
  heap?: { main: number; editor: number };
  how: RestHow | PeakHow;
}

/** The name a reading's metrics start with: `memory.canvas`, and `memory.open.peak` for a peak. */
export const readingPrefix = (r: Pick<MemoryReading, 'label' | 'kind'>) => `memory.${r.label}${r.kind === 'peak' ? '.peak' : ''}`;

/** A reading's metrics: total, process count, each role's resident bytes and count, and the heaps. */
export function readingMetrics(m: Collector, label: string, r: MemoryReading | undefined): void {
  if (!r) return void m.need(`memory reading ${label}`, r);
  const p = readingPrefix(r);
  m.count(`${p}.total`, r.total, 'memory');
  m.count(`${p}.processes`, r.count);
  for (const [role, v] of Object.entries(r.roles)) {
    m.count(`${p}.mem.${role}`, v.bytes, 'memory');
    m.count(`${p}.processes.${role}`, v.processes);
  }
  if (r.heap) {
    m.count(`${p}.heap.main`, r.heap.main, 'memory');
    m.count(`${p}.heap.editor`, r.heap.editor, 'memory');
  }
}

/**
 * What changed from one reading at rest to a later one in the same launch (`memory.<label>.growth.*`): what the work in
 * between left behind. A role in only one of them counts as none in the other.
 */
export function growthMetrics(m: Collector, label: string, from: MemoryReading | undefined, to: MemoryReading | undefined): void {
  if (!from || !to) return;
  const p = `memory.${label}.growth`;
  m.count(`${p}.total`, to.total - from.total, 'memory');
  m.count(`${p}.processes`, to.count - from.count);
  for (const role of [...new Set([...Object.keys(from.roles), ...Object.keys(to.roles)])].sort()) {
    m.count(`${p}.mem.${role}`, (to.roles[role]?.bytes ?? 0) - (from.roles[role]?.bytes ?? 0), 'memory');
    m.count(`${p}.processes.${role}`, (to.roles[role]?.processes ?? 0) - (from.roles[role]?.processes ?? 0));
  }
  if (from.heap && to.heap) {
    m.count(`${p}.heap.main`, to.heap.main - from.heap.main, 'memory');
    m.count(`${p}.heap.editor`, to.heap.editor - from.heap.editor, 'memory');
  }
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

/** What a probe reads the app through: the Electron app in a run, fakes in the unit tests. */
export interface MemorySource {
  /** The machine's process table with resident memory. */
  table(): Promise<MemoryRow[]>;
  facts(signal?: AbortSignal): Promise<AppFacts>;
  /** Collect garbage `passes` times in each process it can reach; the roles it collected in. Stops once `signal` aborts. */
  collect(passes: number, signal?: AbortSignal): Promise<string[]>;
  heap(signal?: AbortSignal): Promise<{ main: number; editor: number }>;
  source: string;
}

export interface Clock {
  now(): number;
  /** Resolves after `ms`, or as soon as `signal` is aborted. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted || ms <= 0) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done);
    })
};

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** How long closing a probe waits for the calls it made to the app and the OS to return. */
const DRAIN_MS = 10_000;

/**
 * The readings of one iteration. A probe is made only for a chain with a memory scenario, and closed (`dispose`) by the
 * iteration before the app is quit, whatever state a scenario left it in: a peak's sampling stops then, the calls it
 * has made are waited for (for a while), and every later call fails, a peak's work included.
 */
export class MemoryProbe {
  readonly readings: MemoryReading[] = [];
  private readonly remembered = new Map<string, string>();
  private readonly known: ProcessEntry[] = [];
  private readonly abort = new AbortController();
  private readonly inflight = new Set<Promise<unknown>>();
  private sampling: Promise<void> | null = null;
  private peaking = false;

  constructor(
    private readonly src: MemorySource,
    private readonly clock: Clock = realClock,
    private readonly rest_ = REST,
    private readonly periodMs = PEAK_PERIOD_MS
  ) {}

  private live() {
    if (this.abort.signal.aborted) throw new Error('the memory probe was closed');
  }

  /** A call to the app or the OS, never made once the probe is closed, and kept until it settles so closing can wait for it. */
  private call<T>(make: () => Promise<T>): Promise<T> {
    this.live();
    const p = make();
    this.inflight.add(p);
    const done = () => void this.inflight.delete(p);
    p.then(done, done);
    return p;
  }

  /** Every process the probe has seen as the app's, by identity: the teardown sweep is given them too. */
  seen(): ProcessEntry[] {
    return [...this.known];
  }

  /** The app's processes in `table`: everything the main process owns, and any process seen as the app's before. */
  private owned(table: MemoryRow[], main: number): MemoryRow[] {
    const rows = ownedEntries(table, main, this.known);
    for (const r of rows) if (!this.known.some((k) => k.pid === r.pid && k.started === r.started)) this.known.push({ pid: r.pid, ppid: r.ppid, started: r.started });
    return rows;
  }

  private async snapshot() {
    const facts = await this.call(() => this.src.facts(this.abort.signal));
    const rows = this.owned(await this.call(() => this.src.table()), facts.main);
    const processes = attribute(rows, mergeFacts([{ facts, rows }]), this.remembered);
    return { rows, processes, ids: rows.map(identity).sort(), complete: complete(rows) };
  }

  /**
   * A reading at rest, `label`: left alone for the settle time, then once two process tables in a row list the same
   * processes, garbage collected, the heaps read, and one sample taken whose processes are still that set. A change
   * meanwhile (or a collection that failed because a process went) starts it again, a few times; a set that never holds
   * still for one gap within the wait fails it.
   */
  async rest(label: string): Promise<MemoryReading> {
    this.live();
    const R = this.rest_;
    const asked = this.clock.now();
    await this.clock.sleep(R.settleMs, this.abort.signal);
    const deadline = this.clock.now() + R.stableMaxMs;
    let settledMs = 0;
    for (let attempt = 0; ; attempt++) {
      const waitFrom = this.clock.now();
      let prev: string[] | null = null;
      let ids: string[] = [];
      for (;;) {
        this.live();
        const s = await this.snapshot();
        ids = s.ids;
        if (prev && sameSet(prev, ids) && s.complete) break;
        if (this.clock.now() >= deadline) throw new Error(`memory reading ${label}: the app's processes never stopped changing`);
        prev = ids;
        await this.clock.sleep(R.stableGapMs, this.abort.signal);
      }
      settledMs += this.clock.now() - waitFrom;
      const again = () => {
        if (attempt + 1 >= R.retries) throw new Error(`memory reading ${label}: the app's processes kept changing while it was taken`);
      };
      this.live();
      let collected: string[];
      let heap: { main: number; editor: number };
      try {
        collected = await this.call(() => this.src.collect(R.gcPasses, this.abort.signal));
        await this.clock.sleep(R.postGcMs, this.abort.signal);
        this.live();
        heap = await this.call(() => this.src.heap(this.abort.signal));
      } catch (e) {
        this.live();
        // A process that went while it was being collected or read is a change of the set, not a broken reading.
        if (sameSet((await this.snapshot()).ids, ids)) throw e;
        again();
        continue;
      }
      // Read after the heaps, so the processes they came from are the ones the sample has.
      const s = await this.snapshot();
      if (!sameSet(s.ids, ids) || !s.complete) {
        again();
        continue;
      }
      // Closed meanwhile: no reading is published for a scenario that has already been given up on.
      this.live();
      const at = this.clock.now();
      const reading: MemoryReading = {
        label,
        kind: 'rest',
        at,
        processes: s.processes,
        roles: byRole(s.processes),
        total: s.processes.reduce((n, p) => n + p.bytes, 0),
        count: s.processes.length,
        heap,
        how: { source: this.src.source, protocol: MEMORY_PROTOCOL, waitedMs: at - asked, settledMs, collected, gcPasses: R.gcPasses, postGcMs: R.postGcMs, retries: attempt }
      };
      this.readings.push(reading);
      return reading;
    }
  }

  /**
   * `work`, with the process table sampled from before it starts until after it ends; its result once the peak,
   * `label`, is recorded. Sampling never waits on the app (a busy main process cannot hide its own spike): the app is
   * asked who the processes are only when one appears that has no role yet, beside the sampling, and again if more
   * appear while it answers. A sampling failure fails the peak once the work is done.
   */
  async peak<T>(label: string, work: () => Promise<T>): Promise<T> {
    this.live();
    if (this.peaking) throw new Error(`memory peak ${label}: another peak is being sampled`);
    this.peaking = true;
    const stop = new AbortController();
    const signal = AbortSignal.any([stop.signal, this.abort.signal]);
    let loop: Promise<void> | null = null;
    try {
      const first = await this.call(() => this.src.facts(this.abort.signal));
      const main = first.main;
      const samples: Array<{ t: number; rows: MemoryRow[] }> = [];
      const facts: Array<{ facts: AppFacts; rows: MemoryRow[] }> = [];
      const seen = new Set<string>();
      const state: { failure: Error | null; asking: Promise<void> | null; again: number | null; failedAsks: number } = { failure: null, asking: null, again: null, failedAsks: 0 };
      // The app's answer is matched to the processes sampled since the one that set it off asking, the latest per pid.
      const ask = (from: number) => {
        if (this.abort.signal.aborted) return;
        if (state.asking) return void (state.again ??= from);
        state.asking = this.call(() => this.src.facts(this.abort.signal)).then(
          (f) => void facts.push({ facts: f, rows: samples.slice(from).flatMap((s) => s.rows) }),
          () => {
            if (++state.failedAsks < 3) state.again ??= from;
          }
        );
        void state.asking.finally(() => {
          state.asking = null;
          const next = state.again;
          state.again = null;
          // Asked again for what appeared meanwhile, even once the work is done: the answer names the peak's processes.
          if (next !== null && !this.abort.signal.aborted) ask(next);
        });
      };
      const sample = async () => {
        const t = this.clock.now();
        const rows = this.owned(await this.call(() => this.src.table()), main);
        samples.push({ t, rows });
        let unseen = false;
        for (const r of rows) if (!seen.has(identity(r))) (seen.add(identity(r)), (unseen = true));
        if (unseen && samples.length > 1) ask(samples.length - 1);
      };
      await sample();
      facts.push({ facts: first, rows: samples[0].rows });
      // Closed meanwhile (the scenario ran past its deadline): the work never starts.
      this.live();
      loop = (async () => {
        while (!signal.aborted) {
          // A period from the last sample's start: a slow table is not followed by a full period more.
          await this.clock.sleep(this.periodMs - (this.clock.now() - samples[samples.length - 1].t), signal);
          if (signal.aborted) break;
          try {
            await sample();
          } catch (e) {
            state.failure = e as Error;
            break;
          }
        }
      })();
      this.sampling = loop;
      const result = await work();
      stop.abort();
      await loop;
      this.live();
      await sample();
      const last = samples[samples.length - 1];
      while (state.asking) await state.asking;
      facts.push({ facts: await this.call(() => this.src.facts(this.abort.signal)), rows: last.rows });
      if (state.failure) throw new Error(`memory peak ${label}: the process table could not be read (${state.failure.message})`);
      this.live();
      this.readings.push(peakReading(label, samples, mergeFacts(facts), this.remembered, { source: this.src.source, protocol: MEMORY_PROTOCOL, periodMs: this.periodMs, samples: samples.length, maxGapMs: maxGap(samples.map((s) => s.t)), durationMs: last.t - samples[0].t }));
      return result;
    } finally {
      stop.abort();
      await loop;
      this.sampling = null;
      this.peaking = false;
    }
  }

  /**
   * Stop any sampling, wait (up to `drainMs`) for the calls already made, and refuse every later reading. Safe to call
   * more than once.
   */
  async dispose(drainMs = DRAIN_MS): Promise<void> {
    this.abort.abort();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.allSettled([this.sampling, ...this.inflight]), new Promise<void>((r) => (timer = setTimeout(r, drainMs)))]);
    clearTimeout(timer);
  }
}

const maxGap = (ts: number[]) => ts.slice(1).reduce((g, t, i) => Math.max(g, t - ts[i]), 0);

/** A peak from its samples: the highest total and count, each role's highest sum and count, each process's highest. */
export function peakReading(label: string, samples: Array<{ t: number; rows: MemoryRow[] }>, facts: RoleFacts, remembered: Map<string, string>, how: Omit<PeakHow, 'incomplete'>): MemoryReading {
  let total = 0;
  let count = 0;
  const roles: Record<string, { processes: number; bytes: number }> = {};
  const highest = new Map<string, ProcessMemory>();
  let incomplete = 0;
  for (const s of samples) {
    // Every sample teaches roles; one missing a process's figure would lower the peak: it is counted, not used.
    const attributed = attributeRows(s.rows, facts, remembered);
    if (!complete(s.rows)) {
      incomplete++;
      continue;
    }
    const processes = attributed.map(({ row, role }) => ({ role, bytes: row.bytes, pid: row.pid }));
    total = Math.max(total, processes.reduce((n, p) => n + p.bytes, 0));
    count = Math.max(count, processes.length);
    for (const [role, v] of Object.entries(byRole(processes))) {
      const r = (roles[role] ??= { processes: 0, bytes: 0 });
      r.processes = Math.max(r.processes, v.processes);
      r.bytes = Math.max(r.bytes, v.bytes);
    }
    for (const { row, role } of attributed) {
      const key = `${identity(row)}:${role}`;
      if ((highest.get(key)?.bytes ?? -1) < row.bytes) highest.set(key, { role, bytes: row.bytes, pid: row.pid });
    }
  }
  if (incomplete === samples.length) throw new Error(`memory peak ${label}: none of its ${samples.length} samples had every process's figure`);
  return { label, kind: 'peak', at: samples[0]?.t ?? 0, processes: [...highest.values()].sort(byRoleThenPid), roles, total, count, how: { ...how, incomplete } };
}

// ---------------------------------------------------------------------------
// The app, through Playwright
// ---------------------------------------------------------------------------

/** The canvas's preview frame in the editor, by the name the canvas gives it. */
const previewName = (win: Page) => win.evaluate(() => (globalThis as unknown as { document: { querySelector(s: string): { getAttribute(n: string): string | null } | null } }).document.querySelector('.frame-box iframe')?.getAttribute('name') ?? null);

/**
 * A probe's source for a launched app: the process table, what the main process says of its processes and windows,
 * garbage collection through an inspector session in the main process and CDP sessions on the editor and the preview's
 * frame, and the heaps. Every session is detached before the call returns.
 */
export function electronSource(app: ElectronApplication, win: Page): MemorySource {
  const closed = (signal?: AbortSignal) => {
    if (signal?.aborted) throw new Error('the memory probe was closed');
  };
  const cdp = async <T>(target: Page | Frame, fn: (send: (method: string) => Promise<unknown>) => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const session = await win.context().newCDPSession(target);
    try {
      closed(signal);
      return await fn((method) => session.send(method as 'HeapProfiler.collectGarbage'));
    } finally {
      await session.detach().catch(() => undefined);
    }
  };
  return {
    source: memorySource(),
    table: () => memoryTable(),
    async facts(signal) {
      const frameName = await previewName(win);
      closed(signal);
      // By its address: `app:` is not a scheme Node gives an origin to, so the editor's and a blank window's would match.
      const editorUrl = win.url().split('#')[0];
      // Sent to the main process as source: no named functions inside (the TypeScript runner would wrap them in a
      // helper the main process does not have).
      return app.evaluate(
        ({ app, BrowserWindow }, a) => {
          const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && !w.webContents.isDestroyed());
          const editor = wins.find((w) => w.webContents.getURL().split('#')[0] === a.editorUrl);
          let preview: number | null = null;
          try {
            const frame = a.frameName && editor ? editor.webContents.mainFrame.framesInSubtree.find((f) => f.name === a.frameName) : undefined;
            preview = frame ? frame.osProcessId : null;
          } catch {
            preview = null;
          }
          return {
            main: process.pid,
            editor: editor ? editor.webContents.getOSProcessId() : null,
            preview,
            windows: wins.filter((w) => w !== editor).map((w) => ({ pid: w.webContents.getOSProcessId(), focusable: w.isFocusable() })),
            processes: app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, label: (m.serviceName === 'node.mojom.NodeService' ? m.name : (m.serviceName ?? m.name)) ?? null, created: m.creationTime ?? null }))
          };
        },
        { editorUrl, frameName }
      );
    },
    async collect(passes, signal) {
      // Each step, each pass in the main process included, is its own call to the app: none starts once the probe is closed.
      const going = () => closed(signal);
      for (let pass = 0; pass < passes; pass++) {
        going();
        await app.evaluate(async (_electron, n) => {
          const inspector = process.getBuiltinModule('node:inspector');
          const session = new inspector.Session();
          session.connect();
          try {
            for (let i = 0; i < n; i++) await new Promise<void>((resolve, reject) => session.post('HeapProfiler.collectGarbage', (e) => (e ? reject(e) : resolve())));
          } finally {
            session.disconnect();
          }
        }, 1);
      }
      const collected = ['main'];
      const gc = async (send: (method: string) => Promise<unknown>) => {
        for (let i = 0; i < passes; i++) {
          going();
          await send('HeapProfiler.collectGarbage');
        }
      };
      going();
      await cdp(win, gc, signal);
      collected.push('editor');
      going();
      const name = await previewName(win);
      const frame = name ? win.frames().find((f) => f.name() === name && f.parentFrame() === win.mainFrame()) : undefined;
      going();
      const facts = frame ? await this.facts(signal) : null;
      going();
      // A frame in the editor's own process (no site isolation) was collected with the editor.
      if (frame && facts && facts.preview !== null && facts.preview !== facts.editor) {
        await cdp(frame, gc, signal);
        collected.push('preview');
      }
      return collected;
    },
    async heap(signal) {
      const main = await app.evaluate(() => process.memoryUsage().heapUsed);
      closed(signal);
      const editor = await cdp(win, async (send) => ((await send('Runtime.getHeapUsage')) as { usedSize: number }).usedSize, signal);
      return { main, editor };
    }
  };
}
