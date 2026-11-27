/**
 * Welcome's recent projects are asked for at launch beside the open project, not once that answer is in and Welcome has
 * mounted (#958): the list asked for then is Welcome's first reading, taken once (and shown in its first render when it
 * has come by then), and dropped when a project opens first, so a later Welcome reads the list afresh.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecentProject } from '@shared/api';

const MODULE = '../../src/renderer/src/lib/early-recents';
type Asked = { list: Promise<RecentProject[]>; settled?: RecentProject[] };
type Early = { askRecentsEarly(ask: () => Promise<RecentProject[]>): void; peekEarlyRecents(): Asked | null; takeEarlyRecents(): Asked | null };
const load = () => import(/* @vite-ignore */ MODULE) as Promise<Early>;
const project = (name: string) => ({ name, dir: `/projects/${name}` }) as RecentProject;

describe('the recent projects asked for at launch', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('asks at once, and gives the answer to the first reading only', async () => {
    const { askRecentsEarly, takeEarlyRecents } = await load();
    expect(takeEarlyRecents()).toBeNull();
    const ask = vi.fn(async () => [project('One')]);
    askRecentsEarly(ask);
    // Asked before anyone reads it: the request is under way while the open project is still being asked for.
    expect(ask).toHaveBeenCalledTimes(1);
    const first = takeEarlyRecents()!;
    expect(await first.list).toEqual([project('One')]);
    // Once it has come, Welcome's first render can show it without waiting for another.
    expect(first.settled).toEqual([project('One')]);
    // Every later reading (Welcome shown again, a Pin, a Remove) asks afresh.
    expect(takeEarlyRecents()).toBeNull();
  });

  it('can be looked at by a render without being taken: a render thrown away leaves it for the one that shows', async () => {
    const { askRecentsEarly, peekEarlyRecents, takeEarlyRecents } = await load();
    askRecentsEarly(async () => [project('One')]);
    const seen = peekEarlyRecents();
    expect(peekEarlyRecents()).toBe(seen);
    expect(takeEarlyRecents()).toBe(seen);
    expect(peekEarlyRecents()).toBeNull();
  });

  it('is dropped unread when a project opens first', async () => {
    const { askRecentsEarly, takeEarlyRecents } = await load();
    askRecentsEarly(async () => [project('Stale')]);
    // openSnapshot drops it.
    takeEarlyRecents();
    expect(takeEarlyRecents()).toBeNull();
  });

  it('a request that fails is left to the reading that takes it, never an unhandled rejection', async () => {
    const { askRecentsEarly, takeEarlyRecents } = await load();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      askRecentsEarly(() => Promise.reject(new Error('The recent projects could not be read')));
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).not.toHaveBeenCalled();
      const failed = takeEarlyRecents()!;
      expect(failed.settled).toBeUndefined();
      await expect(failed.list).rejects.toThrow('could not be read');
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
