// The assistant's event journal in automated runs (src/main/ai-journal.ts, issue #495): every event kept in the order
// it was sent and read back from a cursor, bounded by count and by size with the gap said rather than hidden, and the
// cap on requests a test may set before any reaches a model.
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('counts its size in bytes, and frees what it lets go', () => {
    const j = new AiJournal({ maxBytes: 200 });
    // 60 characters of three bytes each: over the bound on its own count of bytes, not of characters.
    j.record({ text: '€'.repeat(60) });
    j.record({ text: 'a' });
    expect(j.read(0).records.map((r) => r.seq)).toEqual([2]);
    // Once the large ones are gone, small ones fit again.
    j.record({ text: 'b'.repeat(190) });
    j.record({ text: 'c' });
    j.record({ text: 'd' });
    expect(j.read(0).records.map((r) => r.seq)).toEqual([4, 5]);
    j.record({ text: 'e' });
    expect(j.read(0).records.map((r) => r.seq)).toEqual([4, 5, 6]);
  });

  it('keeps only the latest of a run’s streamed text in a row, which holds all the earlier text', () => {
    const j = new AiJournal();
    const text = (runId: string, t: string) => ({ runId, conversationId: 'c_a', kind: 'text', text: t });
    j.record(ev('run_a', 1));
    j.record(text('run_a', 'H'));
    j.record(text('run_a', 'He'));
    j.record(text('run_a', 'Hello'));
    j.record(text('run_b', 'Other'));
    j.record(text('run_a', 'Hello again'));
    const page = j.read(0);
    expect(page.records.map((r) => [r.seq, (r.event as any).text ?? null])).toEqual([
      [1, null],
      [4, 'Hello'],
      [5, 'Other'],
      [6, 'Hello again']
    ]);
    // A reader that saw the text it replaced misses nothing.
    expect(j.read(2).missed).toBe(0);
  });

  it('keeps a turn streamed as pieces whole, from its run’s text so far or its message as last sent', () => {
    const j = new AiJournal();
    const piece = (t: string, at?: number, runId = 'run_a') => ({ runId, conversationId: 'c_a', kind: 'text', text: t, ...(at === undefined ? {} : { at }) });
    j.record(piece('Hel'));
    j.record(piece('lo', 3));
    j.record(piece(', world', 5));
    expect(j.read(0).records.map((r) => r.event)).toEqual([{ runId: 'run_a', conversationId: 'c_a', kind: 'text', text: 'Hello, world' }]);
    // The run's message as sent (its text cleared for the next step) is what the next piece follows.
    j.record({ runId: 'run_a', conversationId: 'c_a', kind: 'message', message: { id: 'm_a', role: 'assistant', text: 'Next' } });
    j.record(piece(' step', 4));
    // Another run's pieces never join this one's text.
    j.record(piece('Other', undefined, 'run_b'));
    j.record(piece('!', 5, 'run_b'));
    expect(j.read(0).records.map((r) => (r.event as { text?: string }).text ?? null)).toEqual(['Hello, world', null, 'Next step', 'Other!']);
  });

  it('never counts text a later record replaced as missed, even once the reader has fallen behind', () => {
    const j = new AiJournal({ maxRecords: 2 });
    j.record(ev('run_a', 1));
    j.record(ev('run_a', 2));
    j.record({ runId: 'run_a', conversationId: 'c_a', kind: 'text', text: 'H' });
    j.record({ runId: 'run_a', conversationId: 'c_a', kind: 'text', text: 'Hi' });
    j.record(ev('run_a', 5));
    const page = j.read(2);
    expect(page.records.map((r) => r.seq)).toEqual([4, 5]);
    expect(page.missed).toBe(0);
    // Those truly let go (seqs 1 and 2) are still counted.
    expect(j.read(0).missed).toBe(2);
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
    expect(j.limitTurns(2)).toMatchObject({ used: 1, limit: 2 });
    expect(j.admit()).toBe(true);
    expect(j.admit()).toBe(false);
    expect(j.turns()).toMatchObject({ used: 2, limit: 2 });
  });

  it('gives back the turn of a request that was refused before it started', () => {
    const j = new AiJournal();
    j.limitTurns(1);
    expect(j.admit()).toBe(true);
    j.giveBack();
    expect(j.admit()).toBe(true);
    expect(j.admit()).toBe(false);
  });

  it('stops everything at a cap of none, and lifts with null without forgetting what was used', () => {
    const j = new AiJournal();
    expect(j.admit()).toBe(true);
    j.limitTurns(0);
    expect(j.admit()).toBe(false);
    j.limitTurns(null);
    expect(j.admit()).toBe(true);
    expect(j.limitTurns(2)).toMatchObject({ used: 2, limit: 2 });
    expect(j.admit()).toBe(false);
  });

  it('gives back only the turn refused', () => {
    const j = new AiJournal();
    j.limitTurns(3);
    j.admit();
    j.admit();
    j.giveBack();
    expect(j.turns().used).toBe(1);
  });

  describe('with a deadline', () => {
    afterEach(() => vi.useRealTimers());

    it('admits nothing once it passes, and stops what is running then, once', () => {
      vi.useFakeTimers();
      let t = 0;
      const j = new AiJournal({ now: () => t });
      let stops = 0;
      j.onSpent(() => stops++);
      expect(j.limitTurns(5, 1000)).toEqual({ used: 0, limit: 5, deadline: 1000, spent: false });
      expect(j.admit()).toBe(true);
      t = 999;
      vi.advanceTimersByTime(999);
      expect([j.admit(), stops]).toEqual([true, 0]);
      t = 1000;
      vi.advanceTimersByTime(1);
      expect(stops).toBe(1);
      expect(j.admit()).toBe(false);
      expect(j.turns()).toMatchObject({ used: 2, spent: true });
      vi.advanceTimersByTime(10_000);
      expect(stops).toBe(1);
    });

    it('refuses past the deadline even before its timer has run', () => {
      let t = 0;
      const j = new AiJournal({ now: () => t });
      j.limitTurns(null, 50);
      t = 60;
      expect(j.admit()).toBe(false);
      expect(j.turns().spent).toBe(true);
    });

    it('survives a stop that throws', () => {
      vi.useFakeTimers();
      const j = new AiJournal({ now: () => Date.now() });
      j.onSpent(() => {
        throw new Error('no window');
      });
      j.limitTurns(1, 10);
      expect(() => vi.advanceTimersByTime(20)).not.toThrow();
      expect(j.admit()).toBe(false);
    });
  });
});
