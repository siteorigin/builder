/**
 * The Posts writer's unsaved text (#395): saved after a pause in typing, at once when the writer is left, never in the
 * middle of a composition, one save at a time with nothing typed meanwhile dropped, and held (not lost) when a save is
 * refused.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { RichText } from '@shared/types';
import { PostDraft, flushOpenPost, setOpenWriter, type DraftSaveOutcome } from '../../src/renderer/src/lib/post-draft';
import { registerFlush, resetPendingForTests, settle } from '../../src/renderer/src/lib/pending';

const para = (t: string): RichText => [{ type: 'p', spans: [{ text: t }] }];

/** A writer whose text is `text`, with saves answered by hand and timers run by hand. */
function harness() {
  let text = '';
  const saves: Array<{ body: RichText; answer: (o: DraftSaveOutcome) => void }> = [];
  const timers = new Map<number, () => void>();
  let next = 0;
  const states: Array<{ dirty: boolean; saving: boolean; problem: unknown }> = [];
  const draft = new PostDraft({
    read: () => para(text),
    save: (body) => new Promise((answer) => saves.push({ body, answer })),
    onChange: (s) => states.push(s),
    setTimer: (fn) => (timers.set(++next, fn), next),
    clearTimer: (t) => void timers.delete(t as number)
  });
  const type = (t: string) => {
    text = t;
    draft.input();
  };
  const tick = () => {
    const due = [...timers.values()];
    timers.clear();
    due.forEach((f) => f());
  };
  const settled = () => new Promise((r) => setTimeout(r, 0));
  return { draft, type, tick, saves, timers, states, settled, setText: (t: string) => (text = t) };
}

describe('the post draft', () => {
  it('saves after a pause in typing, the latest text, once', async () => {
    const h = harness();
    h.type('Hel');
    h.type('Hello');
    expect(h.draft.dirty).toBe(true);
    expect(h.saves).toHaveLength(0);
    expect(h.timers.size).toBe(1);
    h.tick();
    expect(h.saves.map((s) => s.body)).toEqual([para('Hello')]);
    h.saves[0].answer({ kind: 'applied' });
    await h.settled();
    expect(h.draft.dirty).toBe(false);
  });

  it('keeps what is typed while a save is on its way, and saves it next', async () => {
    const h = harness();
    h.type('One');
    const flushed = h.draft.flush();
    h.type('One two');
    // A second flush joins the save under way rather than sending another beside it.
    const again = h.draft.flush();
    expect(h.saves).toHaveLength(1);
    h.saves[0].answer({ kind: 'applied' });
    await h.settled();
    // The first save's answer covers only what it read.
    expect(h.draft.dirty).toBe(true);
    expect(h.saves.map((s) => s.body)).toEqual([para('One'), para('One two')]);
    h.saves[1].answer({ kind: 'applied' });
    expect(await flushed).toBe(true);
    expect(await again).toBe(true);
    expect(h.draft.dirty).toBe(false);
  });

  it('never saves in the middle of a composition, and saves what it composed once it ends', async () => {
    const h = harness();
    h.draft.compositionStart();
    h.type('にほ');
    expect(h.timers.size).toBe(0);
    expect(await h.draft.flush()).toBe(false);
    expect(h.saves).toHaveLength(0);
    h.type('日本');
    h.draft.compositionEnd();
    h.tick();
    expect(h.saves.map((s) => s.body)).toEqual([para('日本')]);
    h.saves[0].answer({ kind: 'applied' });
    await h.settled();
    expect(h.draft.dirty).toBe(false);
  });

  it('holds text the AI kept from saving, and saves it when asked again', async () => {
    const h = harness();
    h.type('Draft');
    const first = h.draft.flush();
    h.saves[0].answer({ kind: 'busy' });
    expect(await first).toBe(false);
    expect(h.draft.dirty).toBe(true);
    expect(h.draft.problem).toEqual({ kind: 'busy' });
    const retried = h.draft.retry();
    h.saves[1].answer({ kind: 'applied' });
    expect(await retried).toBe(true);
    expect(h.draft.problem).toBeNull();
  });

  it('waits for the author when the saved text changed elsewhere, and saves theirs when they keep it', async () => {
    const h = harness();
    h.type('Mine');
    const first = h.draft.flush();
    h.saves[0].answer({ kind: 'changed' });
    expect(await first).toBe(false);
    // More typing does not overwrite the other change behind the author's back.
    h.type('Mine still');
    h.tick();
    await h.settled();
    expect(h.saves).toHaveLength(1);
    const kept = h.draft.retry();
    h.saves[1].answer({ kind: 'applied' });
    expect(await kept).toBe(true);
    expect(h.saves[1].body).toEqual(para('Mine still'));
  });

  it('drops nothing on a refusal: the text stays unsaved until a change is accepted', async () => {
    const h = harness();
    h.type('Too long');
    const first = h.draft.flush();
    h.saves[0].answer({ kind: 'failed', message: 'text is too long.' });
    expect(await first).toBe(false);
    expect(h.draft.dirty).toBe(true);
    expect(h.draft.problem).toEqual({ kind: 'failed', message: 'text is too long.' });
    h.type('Short');
    expect(h.draft.problem).toBeNull();
    h.tick();
    h.saves[1].answer({ kind: 'applied' });
    await h.settled();
    expect(h.draft.dirty).toBe(false);
  });

  it('shows the saved text again without saving anything (reset), and stops for good once closed', async () => {
    const h = harness();
    h.type('Unwanted');
    h.draft.reset();
    expect(h.draft.dirty).toBe(false);
    expect(h.timers.size).toBe(0);
    h.draft.close();
    h.type('After');
    expect(h.timers.size).toBe(0);
    expect(await h.draft.flush()).toBe(true);
    expect(h.saves).toHaveLength(0);
  });
});

describe('saving the open post from elsewhere', () => {
  afterEach(() => resetPendingForTests());

  it('lets the Posts list save the open post before opening another', async () => {
    const h = harness();
    const off = setOpenWriter(() => h.draft.flush());
    h.type('Before switching');
    const done = flushOpenPost();
    expect(h.saves).toHaveLength(1);
    h.saves[0].answer({ kind: 'applied' });
    expect(await done).toBe(true);
    off();
    expect(await flushOpenPost()).toBe(true);
  });

  it('has Save and leaving the project save text the writer holds, focused or not', async () => {
    const h = harness();
    const off = registerFlush(() => h.draft.flush());
    h.type('Unsaved words');
    const saved = settle({ blur: () => undefined, wait: () => new Promise((r) => setTimeout(r, 0)) });
    await h.settled();
    expect(h.saves.map((s) => s.body)).toEqual([para('Unsaved words')]);
    h.saves[0].answer({ kind: 'applied' });
    const out = await saved;
    out.finish();
    expect(out.problems).toEqual([]);
    off();
  });
});
