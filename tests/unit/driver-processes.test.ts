// Ending every process a test session owns (tests/driver/processes.ts): the app, what it started, and what its
// started processes left behind when their parent died.
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { descendants, isAlive, killTree, ownedProcesses, parseProcessTable, processTable } from '../driver/processes.ts';

describe('the process table', () => {
  it('reads ps output and the two-column Windows listing, skipping anything else', () => {
    expect(parseProcessTable('  PID  PPID  PGID\n 10 1 10\n 11 10 10\n\nbad line\n12 11\n')).toEqual([
      { pid: 10, ppid: 1, pgid: 10 },
      { pid: 11, ppid: 10, pgid: 10 },
      { pid: 12, ppid: 11 }
    ]);
  });

  it('finds every process below a root, parents first, and nothing above or beside it', () => {
    const table = parseProcessTable('1 0 1\n10 1 10\n11 10 10\n12 11 10\n13 10 10\n20 1 20\n21 20 20');
    expect(descendants(table, 10)).toEqual([11, 13, 12]);
    expect(descendants(table, 99)).toEqual([]);
  });

  it('owns the root, its tree, and members of its group that were orphaned to init', () => {
    // 12 was started by 11, which died: 12 now hangs off init but is still in the app's group; 30 left the group.
    const table = parseProcessTable('1 0 1\n10 1 10\n13 10 10\n12 1 10\n14 12 10\n30 13 30\n40 1 40');
    expect(ownedProcesses(table, 10).sort((a, b) => a - b)).toEqual([10, 12, 13, 14, 30]);
  });

  it('still finds the group once its leader has exited', () => {
    const table = parseProcessTable('1 0 1\n12 1 10\n14 12 10\n40 1 40');
    expect(ownedProcesses(table, 10).sort((a, b) => a - b)).toEqual([10, 12, 14]);
  });
});

describe.skipIf(process.platform === 'win32')('killing a tree', () => {
  /** A process group like the app's: a detached leader with a child, and a grandchild orphaned by its parent. */
  async function group() {
    // The inner shell starts a sleep and exits at once, so that sleep is re-parented to init but stays in the group.
    const leader = spawn('/bin/sh', ['-c', '/bin/sh -c "sleep 60 & echo \\$!" & sleep 60 & wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const orphan = await new Promise<number>((resolve) => leader.stdout!.once('data', (d) => resolve(Number(String(d).trim()))));
    await new Promise((r) => setTimeout(r, 200));
    return { leader: leader.pid!, orphan };
  }

  it('kills the leader, its children and its orphans, and reports none surviving', async () => {
    const { leader, orphan } = await group();
    const before = ownedProcesses(await processTable(), leader);
    expect(before).toContain(orphan);
    expect(before.length).toBe(3);
    const report = await killTree(leader);
    expect(report.survivors).toEqual([]);
    for (const pid of before) expect(isAlive(pid), `pid ${pid}`).toBe(false);
  });

  it('sweeps a group whose leader already died', async () => {
    const { leader, orphan } = await group();
    process.kill(leader, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 200));
    expect(isAlive(orphan)).toBe(true);
    const report = await killTree(leader);
    expect(report.owned).toContain(orphan);
    expect(report.survivors).toEqual([]);
    expect(isAlive(orphan)).toBe(false);
  });

  it('refuses to kill this process or init', async () => {
    await expect(killTree(process.pid)).rejects.toThrow(/Refusing/);
    await expect(killTree(1)).rejects.toThrow(/Refusing/);
  });
});
