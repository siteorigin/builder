// The assistant's event journal in automated runs (src/main/ai-journal.ts, issue #495): every event kept in the order
// it was sent and read back from a cursor, bounded by count and by size with the gap said rather than hidden, and the
// cap on requests a test may set before any reaches a model.
import { describe, expect, it } from 'vitest';
import { AI_JOURNAL, AiJournal, installAiJournal } from '../../src/main/ai-journal';

const ev = (runId: string, n: number) => ({ runId, conversationId: 'c_a', kind: 'status', status: n % 2 ? 'running' : 'awaiting-input' });

describe('the journal', () => {
  it('keeps every event in the order it was sent, numbered from 1, as sent', () => {
    let t = 1000;
    const j = new AiJournal({ now: () => t++ });
    const sent = { runId: 'run_a', conversationId: 'c_a', kind: 'message', message: { id: 'm_1', role: 'assistant', text: 'Hi', activities: [] } };
    j.record(sent);
    j.record(ev('run_a', 1));
    const page = j.read(0);
    expect(page.records.map((r) => [r.seq, r.at])).toEqual([
      [1, 1000],
      [2, 1001]
    ]);
    expect(page.records[0].event).toEqual(sent);
    expect(page.records[0].event).not.toBe(sent);
    expect([page.next, page.oldest, page.latest, page.missed]).toEqual([2, 1, 2, 0]);
  });

  it('keeps what an event was when it was sent, not what it became', () => {
    const j = new AiJournal();
    const message = { id: 'm_1', text: 'first' };
    j.record({ kind: 'message', message });
    message.text = 'changed later';
    expect((j.read(0).records[0].event as any).message.text).toBe('first');
  });

  it('reads on from a cursor, a page at a time', () => {
    const j = new AiJournal();
    for (let i = 0; i < 5; i++) j.record(ev('run_a', i));
    const a = j.read(0, 2);
    expect(a.records.map((r) => r.seq)).toEqual([1, 2]);
    const b = j.read(a.next, 2);
    expect(b.records.map((r) => r.seq)).toEqual([3, 4]);
    const c = j.read(b.next, 2);
    expect(c.records.map((r) => r.seq)).toEqual([5]);
    const d = j.read(c.next, 2);
    expect([d.records, d.next, d.latest]).toEqual([[], 5, 5]);
  });

  it('lets the oldest go past its count, and tells a reader behind them how many it missed', () => {
    const j = new AiJournal({ maxRecords: 3 });
    for (let i = 0; i < 5; i++) j.record(ev('run_a', i));
    const page = j.read(0);
    expect(page.records.map((r) => r.seq)).toEqual([3, 4, 5]);
    expect([page.oldest, page.missed]).toEqual([3, 2]);
    // A reader that kept up misses nothing.
    expect(j.read(3).missed).toBe(0);
  });

  it('lets the oldest go past its size, but always keeps the newest', () => {
    const j = new AiJournal({ maxBytes: 200 });
    j.record({ text: 'a'.repeat(120) });
    j.record({ text: 'b'.repeat(120) });
    expect(j.read(0).records.map((r) => r.seq)).toEqual([2]);
    j.record({ text: 'c'.repeat(500) });
    expect(j.read(0).records.map((r) => r.seq)).toEqual([3]);
  });

  it('keeps its place for an event it cannot copy', () => {
    const j = new AiJournal();
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    j.record(loop);
    j.record(ev('run_a', 1));
    expect(j.read(0).records.map((r) => [r.seq, r.event])).toEqual([
      [1, { unreadable: true }],
      [2, ev('run_a', 1)]
    ]);
  });

  it('is published for the test on the global it is installed on, and only there', () => {
    const global = {};
    const j = installAiJournal(global);
    expect((global as Record<symbol, unknown>)[AI_JOURNAL]).toBe(j);
    expect((globalThis as Record<symbol, unknown>)[AI_JOURNAL]).toBeUndefined();
  });
});

describe('the cap on requests', () => {
  it('admits every request until a cap is set, then only as many as it allows in all', () => {
    const j = new AiJournal();
    expect(j.admit()).toBe(true);
    expect(j.limitTurns(2)).toEqual({ used: 1, limit: 2 });
    expect(j.admit()).toBe(true);
    expect(j.admit()).toBe(false);
    expect(j.turns()).toEqual({ used: 2, limit: 2 });
  });

  it('gives back the turn of a request that was refused before it started', () => {
    const j = new AiJournal();
    j.limitTurns(1);
    expect(j.admit()).toBe(true);
    j.giveBack();
    expect(j.admit()).toBe(true);
    expect(j.admit()).toBe(false);
  });

  it('stops everything at a cap of none, and lifts with null', () => {
    const j = new AiJournal();
    j.limitTurns(0);
    expect(j.admit()).toBe(false);
    j.limitTurns(null);
    expect(j.admit()).toBe(true);
  });
});
