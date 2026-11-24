/**
 * The processes one app session owns, and ending all of them. Playwright starts Electron as the leader of a new process
 * group (POSIX), and every helper, utility process (the preview's dev server, the media worker) and npm child it starts
 * stays in that group unless it leaves it. A process whose parent died is re-parented to init but keeps its group, so
 * the group finds what a parent/child walk no longer can; the walk finds anything that left the group while its
 * parent lived; and processes seen as owned earlier are remembered by identity (pid and start time) for whatever
 * neither can reach any more. Nothing is signalled by a bare pid that may since have been given to another process.
 */
import { execFile, spawnSync } from 'node:child_process';

export interface ProcessEntry {
  pid: number;
  ppid: number;
  /** The process group; absent on Windows. */
  pgid?: number;
  /** When the process started, as the OS reports it: with the pid, what tells it from a later process given the same pid. */
  started?: string;
}

/**
 * Parse `ps -A -o pid=,ppid=,pgid=,lstart=` output, or the Windows listing (`pid ppid - started`). The first columns are
 * whole numbers (a `-` for no group); the rest of the line is the start time. Other lines are skipped.
 */
export function parseProcessTable(text: string): ProcessEntry[] {
  const out: ProcessEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 2) continue;
    const pid = Number(cols[0]);
    const ppid = Number(cols[1]);
    if (![pid, ppid].every((n) => Number.isInteger(n) && n >= 0) || !/^\d+$/.test(cols[0]) || !/^\d+$/.test(cols[1])) continue;
    const entry: ProcessEntry = { pid, ppid };
    let rest = cols.slice(2);
    if (rest[0] !== undefined && /^\d+$/.test(rest[0])) {
      entry.pgid = Number(rest[0]);
      rest = rest.slice(1);
    } else if (rest[0] === '-') rest = rest.slice(1);
    else if (rest[0] !== undefined && !/^[A-Za-z]/.test(rest[0])) continue;
    if (rest.length) entry.started = rest.join(' ');
    out.push(entry);
  }
  return out;
}

/** Every process below `root` in the table (not `root` itself), parents before their children. */
export function descendants(table: ProcessEntry[], root: number): number[] {
  const children = new Map<number, number[]>();
  for (const p of table) {
    if (p.pid === p.ppid) continue;
    const list = children.get(p.ppid) ?? [];
    list.push(p.pid);
    children.set(p.ppid, list);
  }
  const out: number[] = [];
  const seen = new Set([root]);
  const queue = [root];
  while (queue.length) {
    for (const child of children.get(queue.shift()!) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/**
 * The pids a session owns by position in the table: the app's main process, everything below it, and (POSIX) every
 * member of the group it leads, including orphans the walk no longer reaches. The root comes first.
 */
export function ownedProcesses(table: ProcessEntry[], root: number): number[] {
  const owned = new Set([root, ...descendants(table, root)]);
  // A group keeps its leader's pid as its id after the leader exits, and that pid is not reused while the group lives.
  for (const p of table) {
    if (p.pgid !== root) continue;
    owned.add(p.pid);
    for (const d of descendants(table, p.pid)) owned.add(d);
  }
  return [...owned];
}

const same = (a: ProcessEntry, b: ProcessEntry) => a.pid === b.pid && a.started === b.started;

/** Whether the root pid in `table` is still the process `known` recorded (false once another process has its pid). */
function rootIsOurs(table: ProcessEntry[], root: number, known: ProcessEntry[]): boolean {
  const recorded = known.find((k) => k.pid === root);
  const now = table.find((p) => p.pid === root);
  return !(now && recorded?.started && now.started !== recorded.started);
}

/**
 * The live entries a session owns: those found from the root (unless its pid now belongs to another process), and any
 * process recorded in `known` that is still the same process.
 */
export function ownedEntries(table: ProcessEntry[], root: number, known: ProcessEntry[] = []): ProcessEntry[] {
  const pids = new Set(rootIsOurs(table, root, known) ? ownedProcesses(table, root) : []);
  const out = table.filter((p) => pids.has(p.pid));
  for (const k of known) {
    const now = table.find((p) => p.pid === k.pid);
    if (now && k.started && now.started === k.started && !out.includes(now)) out.push(now);
  }
  return out;
}

function run(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

const WIN_LIST = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) - $($_.CreationDate.Ticks)" }';
const tableCommand = (): [string, string[]] =>
  process.platform === 'win32' ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_LIST]] : ['ps', ['-A', '-o', 'pid=,ppid=,pgid=,lstart=']];

/** This machine's process table. Throws when it cannot be read: an empty table would look like everything had ended. */
export async function processTable(timeoutMs = 10000): Promise<ProcessEntry[]> {
  const [file, args] = tableCommand();
  const table = parseProcessTable(await run(file, args, timeoutMs));
  if (!table.length) throw new Error('The process table came back empty.');
  return table;
}

function processTableSync(): ProcessEntry[] {
  const [file, args] = tableCommand();
  const r = spawnSync(file, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  return r.status === 0 ? parseProcessTable(r.stdout) : [];
}

/** Whether a process with this pid exists (a zombie counts until it is reaped). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The entries still running (same pid, same start), after waiting up to `ms` for them to go. */
export async function waitGone(entries: ProcessEntry[], ms: number): Promise<ProcessEntry[]> {
  const end = Date.now() + ms;
  let left = entries.filter((e) => isAlive(e.pid));
  while (left.length && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 50));
    left = left.filter((e) => isAlive(e.pid));
  }
  if (!left.length) return [];
  // A pid that is alive again may be another process by now: only the same process counts as surviving.
  const table = await processTable().catch((): ProcessEntry[] => []);
  return left.filter((e) => !table.length || table.some((p) => same(p, e)));
}

export interface KillReport {
  /** Every process found to belong to the session while killing. */
  owned: ProcessEntry[];
  /** Those still running when the kill gave up waiting. */
  survivors: ProcessEntry[];
}

function guard(root: number) {
  if (!Number.isInteger(root) || root <= 1 || root === process.pid) throw new Error(`Refusing to kill process tree ${root}`);
}

/**
 * Kill the app and every process it owns, without waiting for any of them to stop on their own. The table is read
 * before the root dies, so its children are still found under it; the root goes first, so nothing is restarted in
 * between (the preview restarts a dev server that stopped unexpectedly), then the rest, then any owned process that
 * appeared meanwhile. `known` are processes seen as owned earlier. Throws when the process table cannot be read.
 */
export async function killTree(root: number, { waitMs = 5000, known = [] }: { waitMs?: number; known?: ProcessEntry[] } = {}): Promise<KillReport> {
  guard(root);
  const before = await processTable();
  const owned = ownedEntries(before, root, known);
  const ours = rootIsOurs(before, root, known);
  if (process.platform === 'win32') {
    if (ours && before.some((p) => p.pid === root)) await run('taskkill', ['/pid', String(root), '/T', '/F'], 10000).catch(() => undefined);
    for (const e of owned) signal(e.pid);
  } else {
    if (ours) signal(-root);
    for (const e of owned) signal(e.pid);
    const after = await processTable().catch(() => before);
    for (const e of ownedEntries(after, root, known)) {
      if (owned.some((o) => same(o, e))) continue;
      owned.push(e);
      signal(e.pid);
    }
  }
  return { owned, survivors: await waitGone(owned, waitMs) };
}

/** killTree for a process that is exiting and cannot wait: signals everything it finds once, synchronously. */
export function killTreeSync(root: number, known: ProcessEntry[] = []): void {
  guard(root);
  const table = processTableSync();
  if (!table.length) return;
  const ours = rootIsOurs(table, root, known);
  if (process.platform === 'win32') {
    if (ours && table.some((p) => p.pid === root)) spawnSync('taskkill', ['/pid', String(root), '/T', '/F'], { timeout: 5000, windowsHide: true });
  } else if (ours) signal(-root);
  for (const e of ownedEntries(table, root, known)) signal(e.pid);
}

function signal(pid: number) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone, or a group that no longer exists.
  }
}
