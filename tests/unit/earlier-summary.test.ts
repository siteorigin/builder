/** The summary of a conversation's older messages that requests carry before the replayed window (issue 745). */
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@shared/api';
import { MAX_REPLAYED_ANSWER, REPLAYED_MESSAGES } from '@shared/turn-model';
import { planReplay, sentMessages, SUMMARY_TURNS, summarizeEarlier, summaryText } from '@shared/earlier-summary';
import type { TurnHistory } from '@shared/turns';

const t = '2026-01-01T00:00:00.000Z';
type Result = NonNullable<ChatMessage['result']>;
const result = (r: Partial<Result> = {}): Result => ({ status: 'no-changes', summary: 'Done.', changes: [], validation: [], canUndo: false, ...r });
let n = 0;
const exchange = (asked: string, reply: Partial<ChatMessage> = {}): ChatMessage[] => {
  n++;
  return [
    { id: `u${n}`, role: 'user', text: asked, time: t },
    { id: `a${n}`, role: 'assistant', text: '', time: t, runId: `run_${n}`, result: result(), ...reply }
  ];
};
const notes = (count: number) => Array.from({ length: count }, (_, i) => exchange(`note ${i}`)).flat();

describe('the summary of the earlier conversation', () => {
  it('starts once the conversation is longer than the replayed window, and replays the rest in full', () => {
    const short = notes(REPLAYED_MESSAGES / 2);
    expect(planReplay(short)).toEqual({ summary: null, recent: short });
    const long = [...exchange('Keep it warm, no blue.'), ...short];
    const plan = planReplay(long);
    expect(plan.recent).toEqual(short);
    expect(plan.summary).toMatchObject({ covered: 2, throughId: long[1].id, omitted: 0, turns: [{ from: 0, asked: 'Keep it warm, no blue.' }] });
    expect(summaryText(plan.summary!)).toContain('The author asked: "Keep it warm, no blue."');
  });

  it('keeps answers with their questions, says which were never answered, and what each turn changed', () => {
    const msgs = exchange('Add a services page', {
      questions: [
        { id: 'q1', text: 'Which accent colour?', choices: ['Blue', 'Amber'], answered: 'Amber' },
        { id: 'q2', text: 'Add prices?', choices: [] }
      ],
      result: result({ status: 'completed', summary: 'Added Services.', changes: [{ label: 'Created page Services' } as never], canUndo: true })
    });
    const text = summaryText(summarizeEarlier(msgs, 2)!);
    expect(text).toContain('Asked "Which accent colour?"; the author answered "Amber".');
    expect(text).toContain('Asked "Add prices?"; it was never answered.');
    expect(text).toContain('Reply: Added Services. Changes: Created page Services.');
  });

  it('reads where each change stands from History when it is sent, not when it was summarised', () => {
    const changed = exchange('Rename the site', { result: result({ status: 'completed', summary: 'Renamed.', canUndo: true }) });
    const runId = changed[1].runId!;
    const summary = summarizeEarlier(changed, 2)!;
    // Another run's step beside it says nothing about this one.
    const at = (applied: boolean): TurnHistory => ({ entries: [{ runId: 'run_other', applied: !applied }, { runId, applied }] });
    expect(summaryText(summary, at(true))).toContain('Its changes are still in the site.');
    expect(summaryText(summary, at(false))).toContain('Its changes were undone afterwards.');
    expect(summaryText(summary, null)).toContain('Whether its changes are still in the site is not known.');
    // Undone, as an earlier version recorded it, with no History to say whether it was redone.
    const marked = summarizeEarlier(exchange('Rename', { result: result({ status: 'completed', summary: 'Renamed. (Undone.)', canUndo: false }) }), 2)!;
    expect(summaryText(marked, null)).toContain('Its changes were undone afterwards, and may have been redone since.');
    // An unfinished turn says so, and loses the app's own "kept, continue" sentences.
    const kept = ' The changes so far are checked and kept, and you can undo them in one step. Reply "continue" to carry on.';
    const unfinished = summarizeEarlier(exchange('Build three pages', { result: result({ status: 'partial', summary: `Built one page.${kept}`, canUndo: true, incomplete: true }) }), 2)!;
    const said = summaryText(unfinished, { entries: [{ runId: unfinished.turns[0].runId!, applied: true }] });
    expect(said).toContain('Reply: Built one page. It stopped before it was finished; its changes are still in the site.');
    expect(said).not.toContain('continue');
    // A turn that changed nothing says how it ended.
    expect(summaryText(summarizeEarlier(exchange('Try', { result: result({ status: 'failed', summary: 'It failed.' }) }), 2)!)).toContain('It failed, and changed nothing.');
    expect(summaryText(summarizeEarlier(exchange('Look', { result: result({ status: 'no-changes', summary: 'Looked.' }) }), 2)!)).toContain('Reply: Looked. It changed nothing.');
    // One that met a file changed outside the app is never said to have changed nothing, nor to have kept it all.
    const conflicted = summaryText(summarizeEarlier(exchange('Edit', { result: result({ status: 'conflicted', summary: 'Kept for review.' }) }), 2)!);
    expect(conflicted).toContain('It ran into a file changed outside the app, so which of its changes remain is not known.');
    expect(conflicted).not.toContain('changed nothing');
  });

  it('keeps no more of an answer than a replay in full sends, and an image chosen by its ID', () => {
    const answer = `${'a'.repeat(MAX_REPLAYED_ANSWER)}PRIVATE TAIL`;
    const long = summarizeEarlier(exchange('Paste it', { questions: [{ id: 'q', text: 'The copy?', choices: [], answered: answer }] }), 2)!;
    expect(long.turns[0].answers![0].a).toMatch(/^[a… ]+$/);
    const images = [{ assetId: 'as_1', name: 'hero' }, { assetId: 'as_2', name: 'hero' }];
    const picked = summarizeEarlier(exchange('Pick one', { questions: [{ id: 'q', text: 'Which image?', choices: [], images, answered: 'hero', answeredAssetId: 'as_2' }] }), 2)!;
    expect(summaryText(picked)).toContain('the author answered "image "hero" (assetId: as_2)"');
  });

  it('lists at most eight changes, and says how many more', () => {
    const changes = Array.from({ length: 11 }, (_, i) => ({ label: `Change ${i}` }) as never);
    const turn = summarizeEarlier(exchange('Many', { result: result({ status: 'completed', changes, canUndo: true }) }), 2)!.turns[0];
    expect(turn.changes).toEqual([...Array.from({ length: 8 }, (_, i) => `Change ${i}`), '3 more']);
    const eight = summarizeEarlier(exchange('Eight', { result: result({ status: 'completed', changes: changes.slice(0, 8), canUndo: true }) }), 2)!.turns[0];
    expect(eight.changes).toEqual(Array.from({ length: 8 }, (_, i) => `Change ${i}`));
  });

  it('keeps the start and the end of a long message', () => {
    const paste = `Here is the brief. ${'Lorem ipsum dolor. '.repeat(200)}Above all: warm colours, no blue.`;
    const asked = summarizeEarlier(exchange(paste), 2)!.turns[0].asked!;
    expect(Array.from(asked).length).toBeLessThanOrEqual(400);
    expect(asked.startsWith('Here is the brief.')).toBe(true);
    expect(asked.endsWith('Above all: warm colours, no blue.')).toBe(true);
    expect(asked).toContain(' … ');
  });

  it('extends a stored summary to the same one building it from the start gives', () => {
    const msgs = notes(SUMMARY_TURNS + REPLAYED_MESSAGES / 2 + 5);
    let stored = null as ReturnType<typeof summarizeEarlier>;
    // Extended an exchange at a time, as a conversation grows.
    for (let end = 2; end <= msgs.length - REPLAYED_MESSAGES; end += 2) stored = summarizeEarlier(msgs, end, stored);
    const built = summarizeEarlier(msgs, msgs.length - REPLAYED_MESSAGES);
    expect(stored).toEqual(built);
    // It stays short: the oldest exchanges are counted, not kept.
    expect(built!.turns).toHaveLength(SUMMARY_TURNS);
    expect(built!.omitted).toBe(5);
    expect(summaryText(built!)).toContain('(5 earlier exchanges are no longer summarized.)');
  });

  it('reuses a stored summary that still matches, and builds a new one when it does not', () => {
    const msgs = notes(REPLAYED_MESSAGES / 2 + 2);
    const stored = { covered: 4, throughId: msgs[3].id, turns: [{ from: 0, asked: 'stored words' }], omitted: 0 };
    expect(planReplay(msgs, stored).summary).toEqual(stored);
    // Stored for another transcript, or not readable: built from the messages.
    // A turn that cannot be written out (an answer that is not one, a count that is not) is not reused either, nor
    // one covering more than the window leaves.
    const broken = [{ ...stored, turns: [{ from: 0, answers: [null] }] }, { ...stored, turns: [{ from: 0, changes: [7] }] }, { ...stored, turns: [{ from: 0, ended: 'maybe' }] }, { ...stored, turns: [{ from: 9 }] }];
    const ahead = { ...stored, covered: 6, throughId: msgs[5].id };
    for (const other of [{ ...stored, throughId: 'elsewhere' }, { ...stored, covered: 99 }, { ...stored, turns: 'x' }, 'junk', null, ...broken, ahead]) {
      const plan = planReplay(msgs, other);
      expect(plan.summary?.turns.map((x) => x.asked)).toEqual(['note 0', 'note 1']);
    }
    // One that covers fewer messages is extended from where it stops; the stored copy is left as it was.
    const extended = summarizeEarlier(msgs, 4, { ...stored, covered: 2, throughId: msgs[1].id })!;
    expect(extended.turns.map((x) => x.asked)).toEqual(['stored words', 'note 1']);
    expect(stored.turns).toHaveLength(1);
  });

  it('pairs a reply with its request across the edge of what it has covered', () => {
    const msgs = notes(REPLAYED_MESSAGES / 2 + 2);
    // Covered up to a request whose reply is still in the window: the reply joins that request's exchange.
    const half = summarizeEarlier(msgs, 3)!;
    expect(half.turns.at(-1)).toEqual({ from: 2, asked: 'note 1' });
    expect(summarizeEarlier(msgs, 4, half)).toEqual(summarizeEarlier(msgs, 4));
    // A reply with no request before it is an exchange of its own.
    const lone: ChatMessage[] = [{ id: 'a', role: 'assistant', text: 'Hello there.', time: t }, ...msgs];
    expect(summarizeEarlier(lone, 1)!.turns).toEqual([{ from: 0, said: 'Hello there.' }]);
    // The reply joins its request: one exchange, with both.
    expect(summarizeEarlier(msgs, 2)!.turns).toEqual([{ from: 0, asked: 'note 0', said: 'Done.', runId: msgs[1].runId }]);
  });

  it('reads a malformed transcript without failing', () => {
    const msgs = [{ id: 'u', role: 'user', text: 'Hello', time: t }, null, ...notes(REPLAYED_MESSAGES / 2)] as unknown as ChatMessage[];
    const plan = planReplay(msgs);
    expect(plan.summary).toMatchObject({ covered: 2, throughId: '', turns: [{ from: 0, asked: 'Hello' }] });
    expect(plan.recent).toHaveLength(REPLAYED_MESSAGES);
  });

  it('names the messages a request carries: the ones the summary holds and the recent ones', () => {
    const msgs = notes(SUMMARY_TURNS + REPLAYED_MESSAGES / 2 + 3);
    // The three oldest exchanges are only counted, so their words never go out.
    expect(sentMessages(msgs)).toEqual(msgs.slice(6));
    const short = notes(3);
    expect(sentMessages(short)).toEqual(short);
    // The replay it is given decides: one that has let more go names fewer.
    const plan = planReplay(msgs);
    expect(sentMessages(msgs, { ...plan, summary: { ...plan.summary!, turns: plan.summary!.turns.slice(2) } })).toEqual(msgs.slice(10));
  });
});
