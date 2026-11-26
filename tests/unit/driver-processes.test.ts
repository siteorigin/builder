// Ending every process a test session owns (tests/driver/processes.ts): the app, what it started, and what its
// started processes left behind when their parent died.
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { descendants, isAlive, killTree, ownedEntries, ownedProcesses, parseProcessTable, processTable } from '../driver/processes.ts';

describe('the process table', () => {
  it('reads ps output with start times, and the Windows listing, skipping anything else', () => {
    expect(parseProcessTable('  PID  PPID  PGID STARTED\n 10 1 10 Mon Nov 24 13:27:01 2026\n 11 10 10\n\nbad line\n12 11\n-3 1 1\n13 -1 1\n14 1 -5\n15 1 - 638700000000000000\n')).toEqual([
      { pid: 10, ppid: 1, pgid: 10, started: 'Mon Nov 24 13:27:01 2026' },
      { pid: 11, ppid: 10, pgid: 10 },
      { pid: 12, ppid: 11 },
      { pid: 15, ppid: 1, started: '638700000000000000' }
    ]);
  });

  it('finds every process below a root once each, parents first, and nothing above or beside it', () => {
    const table = parseProcessTable('1 0 1\n10 1 10\n11 10 10\n12 11 10\n13 10 10\n20 1 20\n21 20 20\n12 11 10');
    expect(descendants(table, 10)).toEqual([11, 13, 12]);
    expect(descendants(table, 99)).toEqual([]);
  });

  it('owns the root, its tree, and members of its group that were orphaned to init', () => {
    // 12 was started by 11, which died: 12 now hangs off init but is still in the app's group; 30 left the group.
    const table = parseProcessTable('1 0 1\n10 1 10\n13 10 10\n12 1 10\n14 12 10\n30 13 30\n40 1 40');
    expect(ownedProcesses(table, 10).sort((a, b) => a - b)).toEqual([10, 12, 13, 14, 30]);
  });

  it('still finds the group once its leader has exited, and what an orphan started outside it', () => {
    const table = parseProcessTable('1 0 1\n12 1 10\n14 12 10\n15 12 50\n40 1 40');
    expect(ownedProcesses(table, 10).sort((a, b) => a - b)).toEqual([10, 12, 14, 15]);
  });

  it('owns nothing through a root pid that another process now has, but keeps what it saw by identity', () => {
    const known = parseProcessTable('10 1 10 Mon Nov 24 13:00:00 2026\n30 1 30 Mon Nov 24 13:00:05 2026\n31 1 31 Mon Nov 24 13:00:06 2026');
    // 10 exited and its pid went to an unrelated program with children of its own; 30 (which had left the group) runs
    // on; 31 exited and its pid went to something else.
    const table = parseProcessTable('1 0 1 Mon Nov 24 09:00:00 2026\n10 1 10 Mon Nov 24 14:00:00 2026\n11 10 10 Mon Nov 24 14:00:01 2026\n30 1 30 Mon Nov 24 13:00:05 2026\n31 1 31 Mon Nov 24 14:00:02 2026');
    expect(ownedEntries(table, 10, known).map((e) => e.pid)).toEqual([30]);
    // While the root is still the process recorded, it and its tree are owned as usual.
    const same = parseProcessTable('10 1 10 Mon Nov 24 13:00:00 2026\n11 10 10 Mon Nov 24 13:00:01 2026');
    expect(ownedEntries(same, 10, known).map((e) => e.pid)).toEqual([10, 11]);
    // With nothing recorded about the root, it is taken as found.
    expect(ownedEntries(same, 10).map((e) => e.pid)).toEqual([10, 11]);
    // What a remembered process started after it left is owned with it.
    const later = parseProcessTable('1 0 1 Mon Nov 24 09:00:00 2026\n30 1 30 Mon Nov 24 13:00:05 2026\n32 30 30 Mon Nov 24 13:10:00 2026\n33 32 33 Mon Nov 24 13:10:01 2026');
    expect(ownedEntries(later, 10, known).map((e) => e.pid)).toEqual([30, 32, 33]);
  });

  it('never takes a Windows process for the child of a later one that got its dead parent’s pid', () => {
    // 20 is the app's helper; 30 is an older program whose parent once had pid 20, and 31 its child. 21 started with
    // 20 (the same tick), so it is 20's.
    const table = parseProcessTable('10 1 - 100\n20 10 - 200\n21 20 - 200\n30 20 - 50\n31 30 - 60');
    expect(descendants(table, 10)).toEqual([20, 21]);
    expect(ownedEntries(table, 10).map((e) => e.pid)).toEqual([10, 20, 21]);
    // A process seen as the app's earlier stays the app's whatever its parent now is, and what it started with it.
    const kept = parseProcessTable('10 1 - 100\n20 10 - 200\n40 20 - 150\n41 40 - 160');
    expect(ownedEntries(kept, 10, [{ pid: 40, ppid: 1, started: '150' }]).map((e) => e.pid)).toEqual([10, 20, 40, 41]);
    // POSIX start times are words: nothing is compared there.
    expect(descendants(parseProcessTable('10 1 10 Mon Nov 24 14:00:00 2026\n11 10 10 Mon Nov 24 13:00:00 2026'), 10)).toEqual([11]);
  });

  it('checks a Windows child of a root that has exited against the root’s start, read while it ran', () => {
    // The app (10, started at tick 100) has quit: 20 is its helper, 30 an older program a previous pid 10 started.
    const table = parseProcessTable('20 10 - 200\n21 20 - 210\n30 10 - 50\n31 30 - 60');
    expect(ownedEntries(table, 10, [{ pid: 10, ppid: 1, started: '100' }]).map((e) => e.pid)).toEqual([20, 21]);
    expect(descendants(table, 10, '100')).toEqual([20, 21]);
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
    expect(report.owned.map((e) => e.pid).sort()).toEqual([...before].sort());
    for (const pid of before) expect(isAlive(pid), `pid ${pid}`).toBe(false);
  });

  it('kills a process seen as owned earlier that has since left the tree and the group', async () => {
    // A detached sleep is a group of its own under this process: nothing ties it to `leader` but the record.
    const { leader } = await group();
    // It is recorded before it starts a child of its own, which nothing then ties to anything but its parent.
    const loner = spawn('/bin/sh', ['-c', 'read go; sleep 60 & echo $!; wait'], { detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    await new Promise((r) => setTimeout(r, 200));
    const entry = (await processTable()).find((p) => p.pid === loner.pid)!;
    expect(entry.started).toBeTruthy();
    loner.stdin!.write('go\n');
    const child = await new Promise<number>((resolve) => loner.stdout!.once('data', (d) => resolve(Number(String(d).trim()))));
    const report = await killTree(leader, { known: [entry] });
    expect(report.owned.map((e) => e.pid)).toEqual(expect.arrayContaining([loner.pid, child]));
    expect(report.survivors).toEqual([]);
    expect([isAlive(loner.pid!), isAlive(child)]).toEqual([false, false]);
  });

  it('sweeps a group whose leader already died', async () => {
    const { leader, orphan } = await group();
    process.kill(leader, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 200));
    expect(isAlive(orphan)).toBe(true);
    const report = await killTree(leader);
    expect(report.owned.map((e) => e.pid)).toContain(orphan);
    expect(report.survivors).toEqual([]);
    expect(isAlive(orphan)).toBe(false);
  });

  it('refuses to kill this process, init, or anything that is not a pid', async () => {
    for (const pid of [process.pid, 1, 0, -5, 1.5]) await expect(killTree(pid), String(pid)).rejects.toThrow(/Refusing/);
  });
});
