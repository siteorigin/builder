/**
 * The processes one app session owns, and ending all of them. Playwright starts Electron as the leader of a new process
 * group (POSIX), and every helper, utility process (the preview's dev server, the media worker) and npm child it starts
 * stays in that group unless it leaves it. A process whose parent died is re-parented to init but keeps its group, so
 * the group finds what a parent/child walk no longer can; the walk finds anything that left the group.
 */
import { execFile } from 'node:child_process';

export interface ProcessEntry {
  pid: number;
  ppid: number;
  /** The process group; absent on Windows. */
  pgid?: number;
}

/** Parse `ps -A -o pid=,ppid=,pgid=` output (or the two-column Windows listing). Lines that are not numbers are skipped. */
export function parseProcessTable(text: string): ProcessEntry[] {
  const out: ProcessEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/).map(Number);
    if (cols.length < 2 || cols.some((n) => !Number.isInteger(n) || n < 0)) continue;
    const [pid, ppid, pgid] = cols;
    out.push(pgid === undefined ? { pid, ppid } : { pid, ppid, pgid });
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
 * The processes a session owns: the app's main process, everything below it, and (POSIX) every member of the group it
 * leads, including orphans the walk no longer reaches. The root comes first.
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

function run(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** This machine's process table. */
export async function processTable(timeoutMs = 10000): Promise<ProcessEntry[]> {
  if (process.platform === 'win32') {
    const ps = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }';
    return parseProcessTable(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], timeoutMs));
  }
  return parseProcessTable(await run('ps', ['-A', '-o', 'pid=,ppid=,pgid='], timeoutMs));
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

/** The pids still alive, after waiting up to `ms` for them to go. */
export async function waitGone(pids: number[], ms: number): Promise<number[]> {
  const end = Date.now() + ms;
  let left = pids.filter(isAlive);
  while (left.length && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 50));
    left = left.filter(isAlive);
  }
  return left;
}

export interface KillReport {
  /** Every process found to belong to the session when the kill began. */
  owned: number[];
  /** Those still alive when the kill gave up waiting. */
  survivors: number[];
}

/**
 * Kill the app and every process it owns, without waiting for any of them to stop on their own. The table is read
 * before the root dies, so its children are still found under it; the root goes first, so nothing is restarted in
 * between (the preview restarts a dev server that stopped unexpectedly), then the rest, then any group member that
 * appeared meanwhile.
 */
export async function killTree(root: number, { waitMs = 5000 }: { waitMs?: number } = {}): Promise<KillReport> {
  if (!Number.isInteger(root) || root <= 1 || root === process.pid) throw new Error(`Refusing to kill process tree ${root}`);
  if (process.platform === 'win32') {
    const owned = ownedProcesses(await processTable().catch(() => []), root);
    await run('taskkill', ['/pid', String(root), '/T', '/F'], 10000).catch(() => undefined);
    for (const pid of owned) signal(pid);
    return { owned, survivors: await waitGone(owned, waitMs) };
  }
  const before = await processTable().catch((): ProcessEntry[] => []);
  const owned = ownedProcesses(before, root);
  signal(-root);
  for (const pid of owned) signal(pid);
  const after = await processTable().catch((): ProcessEntry[] => []);
  for (const pid of ownedProcesses(after, root)) {
    if (!owned.includes(pid)) owned.push(pid);
    signal(pid);
  }
  return { owned, survivors: await waitGone(owned, waitMs) };
}

function signal(pid: number) {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone, or a group that no longer exists.
  }
}
