import { describe, expect, it } from 'vitest';
import { createLeaveGate } from '../../src/main/leave-gate';

/** A gate with manual timers and a record of the requests it sent. */
function setup(reachable = true, onTimeout?: (signal: AbortSignal) => Promise<'wait' | 'leave'>) {
  const sent: string[] = [];
  const timers = new Map<number, () => void>();
  let next = 0;
  let ids = 0;
  const gate = createLeaveGate({
    request: (id) => {
      if (reachable) sent.push(id);
      return reachable;
    },
    timeoutMs: 1000,
    onTimeout,
    newId: () => `r${++ids}`,
    setTimer: (fn) => {
      timers.set(++next, fn);
      return next;
    },
    clearTimer: (t) => void timers.delete(t as number)
  });
  const fire = () => {
    const due = [...timers.entries()];
    timers.clear();
    due.forEach(([, fn]) => fn());
  };
  return { gate, sent, timers, fire };
}

const settled = async <T>(p: Promise<T>) => {
  let done = false;
  let value: T | undefined;
  void p.then((v) => {
    done = true;
    value = v;
  });
  await new Promise((r) => setTimeout(r, 0));
  return { done, value };
};

describe('leave gate', () => {
  it('leaves at once when there is no editor to ask', async () => {
    const { gate, sent } = setup(false);
    expect(await gate.ask()).toBe(true);
    expect(sent).toEqual([]);
    expect(gate.pending).toBe(false);
  });

  it('waits for the editor and follows its answer', async () => {
    const { gate, sent } = setup();
    const stay = gate.ask();
    expect(await settled(stay)).toEqual({ done: false, value: undefined });
    gate.reply(sent[0], 'stay');
    expect(await stay).toBe(false);
    const leave = gate.ask();
    gate.reply(sent[1], 'leave');
    expect(await leave).toBe(true);
  });

  it('shares one question between requests made while it is pending', async () => {
    const { gate, sent } = setup();
    const close = gate.ask();
    const quit = gate.ask();
    expect(sent).toHaveLength(1);
    gate.reply(sent[0], 'stay');
    expect(await close).toBe(false);
    expect(await quit).toBe(false);
  });

  it('ignores replies to an earlier or unknown request', async () => {
    const { gate, sent } = setup();
    const first = gate.ask();
    gate.reply(sent[0], 'stay');
    await first;
    const second = gate.ask();
    gate.reply(sent[0], 'leave');
    gate.reply('nope', 'leave');
    expect((await settled(second)).done).toBe(false);
    gate.reply(sent[1], 'stay');
    expect(await second).toBe(false);
  });

  it('asks the person whether to leave when the editor does not answer in time', async () => {
    const choices: Array<'wait' | 'leave'> = ['wait', 'leave'];
    let questions = 0;
    const hung = setup(true, async () => {
      questions++;
      return choices.shift()!;
    });
    const p = hung.gate.ask();
    hung.fire();
    await new Promise((r) => setTimeout(r, 0));
    // Wait: asked again after another timeout, still pending meanwhile.
    expect((await settled(p)).done).toBe(false);
    expect(hung.timers.size).toBe(1);
    hung.fire();
    expect(await p).toBe(true);
    expect(questions).toBe(2);
  });

  it('withdraws that question when the editor answers after all', async () => {
    let signal: AbortSignal | null = null;
    let answer!: (c: 'wait' | 'leave') => void;
    const slow = setup(true, (s) => {
      signal = s;
      return new Promise((r) => (answer = r));
    });
    const p = slow.gate.ask();
    slow.fire();
    slow.gate.reply(slow.sent[0], 'asking');
    expect(signal!.aborted).toBe(true);
    // The withdrawn question's late answer is ignored: the author is deciding in the editor.
    answer('leave');
    expect((await settled(p)).done).toBe(false);
    slow.gate.reply(slow.sent[0], 'stay');
    expect(await p).toBe(false);
  });

  it('keeps waiting when there is nobody to ask, and as long as the author is deciding', async () => {
    const quiet = setup();
    const p = quiet.gate.ask();
    quiet.fire();
    expect((await settled(p)).done).toBe(false);
    quiet.gate.reply(quiet.sent[0], 'leave');
    expect(await p).toBe(true);

    const deciding = setup();
    const q = deciding.gate.ask();
    deciding.gate.reply(deciding.sent[0], 'asking');
    expect(deciding.timers.size).toBe(0);
    deciding.fire();
    expect((await settled(q)).done).toBe(false);
    deciding.gate.reply(deciding.sent[0], 'stay');
    expect(await q).toBe(false);
  });

  it('withdraws the question when the editor answers outright, and keeps waiting if it cannot be shown', async () => {
    let signal: AbortSignal | null = null;
    const answered = setup(true, (sig) => {
      signal = sig;
      return new Promise(() => undefined);
    });
    const p = answered.gate.ask();
    answered.fire();
    answered.gate.reply(answered.sent[0], 'leave');
    expect(await p).toBe(true);
    expect(signal!.aborted).toBe(true);

    const broken = setup(true, () => Promise.reject(new Error('no dialog')));
    const q = broken.gate.ask();
    broken.fire();
    await new Promise((r) => setTimeout(r, 0));
    // Not shown is never taken as "leave anyway": the wait goes on, and the question comes back later.
    expect((await settled(q)).done).toBe(false);
    expect(broken.timers.size).toBe(1);
    broken.gate.reply(broken.sent[0], 'stay');
    expect(await q).toBe(false);
  });

  it('drops a question whose editor page was reloaded, so asking again reaches the new page', async () => {
    const { gate, sent, timers } = setup();
    const before = gate.ask();
    // Reloaded before it even answered: nothing is left waiting, not even its timer.
    gate.editorReplaced();
    expect(await before).toBe(false);
    expect(timers.size).toBe(0);
    const p = gate.ask();
    gate.reply(sent[1], 'asking');
    gate.editorReplaced();
    expect(await p).toBe(false);
    const again = gate.ask();
    expect(sent).toHaveLength(3);
    gate.reply(sent[2], 'leave');
    expect(await again).toBe(true);
  });

  it('asks the person when the editor hangs while the author is deciding, and withdraws it when it recovers', async () => {
    const signals: AbortSignal[] = [];
    const answers: Array<(c: 'wait' | 'leave') => void> = [];
    const g = setup(true, (sig) => {
      signals.push(sig);
      return new Promise((r) => answers.push(r));
    });
    const p = g.gate.ask();
    g.gate.reply(g.sent[0], 'asking');
    expect(g.timers.size).toBe(0);
    // Hung with the author's question open: no timer runs, so the hang itself brings the person's question.
    g.gate.editorUnresponsive();
    expect(signals).toHaveLength(1);
    // It recovers: the question is withdrawn, and no timer starts while the author is still deciding.
    g.gate.editorResponsive();
    expect(signals[0].aborted).toBe(true);
    expect(g.timers.size).toBe(0);
    answers[0]('leave');
    expect((await settled(p)).done).toBe(false);
    // Hangs again; this time the person leaves anyway.
    g.gate.editorUnresponsive();
    answers[1]('leave');
    expect(await p).toBe(true);
  });

  it('asks again when Close or Quit is chosen while the editor is still hung after Wait', async () => {
    const choices: Array<'wait' | 'leave'> = ['wait', 'leave'];
    let questions = 0;
    const g = setup(true, async () => (questions++, choices.shift()!));
    const p = g.gate.ask();
    g.gate.reply(g.sent[0], 'asking');
    g.gate.editorUnresponsive();
    await new Promise((r) => setTimeout(r, 0));
    expect(questions).toBe(1);
    expect((await settled(p)).done).toBe(false);
    // Still hung: asking again brings the question back, and this time the person leaves.
    const again = g.gate.ask();
    expect(await again).toBe(true);
    expect(questions).toBe(2);
    // Recovered: asking again just waits for the editor.
    g.gate.editorResponsive();
    const later = g.gate.ask();
    g.gate.reply(g.sent[1], 'stay');
    expect(await later).toBe(false);
    expect(questions).toBe(2);
  });

  it('asks at once when the editor hangs before answering, and Wait goes back to the timer', async () => {
    const choices: Array<'wait' | 'leave'> = ['wait'];
    const g = setup(true, async () => choices.shift() ?? 'leave');
    const p = g.gate.ask();
    g.gate.editorUnresponsive();
    await new Promise((r) => setTimeout(r, 0));
    expect(g.timers.size).toBe(1);
    expect((await settled(p)).done).toBe(false);
    g.fire();
    expect(await p).toBe(true);
  });

  it('lets leaving go ahead when the editor window goes away mid-question', async () => {
    const { gate, sent, timers } = setup();
    const p = gate.ask();
    gate.reply(sent[0], 'asking');
    gate.editorGone();
    expect(await p).toBe(true);
    expect(timers.size).toBe(0);
    // A late answer from the gone editor changes nothing.
    gate.reply(sent[0], 'stay');
    expect(gate.pending).toBe(false);
  });
});
