/**
 * A colour picker's drag sends one save at a time: steps picked while one is being saved wait, and only the newest of
 * them is saved once it has been answered (#970). Without the gate every step was saved in turn, and the page showed
 * them one after another long after the drag.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { appliesLanded, resetPendingForTests, savesInFlight } from '../../src/renderer/src/lib/pending';
import { pickGate, sendHeldPicks } from '../../src/renderer/src/lib/pick-gate';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** A project that saves only when the test lets it: what was sent, and the most saves running at once. */
function project() {
  const sent: string[] = [];
  const waiting: Array<{ text: string; answer: (r: unknown) => void; fail: (e: unknown) => void }> = [];
  let running = 0;
  let most = 0;
  /** `asEdit`: sent the way store.ts sends an edit, which sends every held pick ahead of itself first. */
  const save = (text: string, asEdit = false) => () => {
    if (asEdit) sendHeldPicks();
    sent.push(text);
    most = Math.max(most, ++running);
    return new Promise((answer, fail) =>
      waiting.push({
        text,
        answer: (r) => (running--, answer(r)),
        fail: (e) => (running--, fail(e))
      })
    );
  };
  return {
    sent,
    save,
    most: () => most,
    /** Answer the oldest save still waiting. */
    land: async (r: unknown = { ok: true }) => {
      waiting.shift()!.answer(r);
      await tick();
    },
    fail: async () => {
      waiting.shift()!.fail(new Error('the disk is full'));
      await tick();
    },
    waiting: () => waiting.map((w) => w.text)
  };
}

afterEach(() => resetPendingForTests());

describe('a colour picker’s drag', () => {
  it('saves the first step at once, then only the newest step taken while a save was on its way', async () => {
    const p = project();
    const gate = pickGate();
    const dropped: string[] = [];
    for (const c of ['#100000', '#200000', '#300000', '#400000']) gate.pick(p.save(c), () => dropped.push(c));
    expect(p.sent).toEqual(['#100000']);
    // The steps that were overtaken before they were sent are let go, the newest is not.
    expect(dropped).toEqual(['#200000', '#300000']);
    await p.land();
    expect(p.sent).toEqual(['#100000', '#400000']);
    gate.pick(p.save('#500000'));
    await p.land();
    await p.land();
    expect(p.sent).toEqual(['#100000', '#400000', '#500000']);
    expect(p.most()).toBe(1);
    // Nothing left: the next step is sent at once.
    gate.pick(p.save('#600000'));
    expect(p.waiting()).toEqual(['#600000']);
  });

  it('saves the last step after the picker has gone, with nothing else to set it off', async () => {
    const p = project();
    const gate = pickGate();
    gate.pick(p.save('#100000'));
    gate.pick(p.save('#200000'));
    // The picker closes mid-drag, or focus moves: no more steps come. The held step still goes when the save before it is answered.
    await p.land();
    expect(p.sent).toEqual(['#100000', '#200000']);
  });

  it('saves the held step after a save that was refused or failed', async () => {
    const p = project();
    const gate = pickGate();
    gate.pick(p.save('#100000'));
    gate.pick(p.save('#200000'));
    await p.land(null);
    expect(p.sent).toEqual(['#100000', '#200000']);
    gate.pick(p.save('#300000'));
    await p.fail();
    expect(p.sent).toEqual(['#100000', '#200000', '#300000']);
    // A send that throws before it saves anything holds up nothing either.
    await p.land();
    gate.pick(() => {
      throw new Error('no project');
    });
    gate.pick(p.save('#400000'));
    await tick();
    expect(p.sent.at(-1)).toBe('#400000');
  });

  it('sends every held step at once when anything else is about to reach the project, so nothing overtakes a pick', async () => {
    const p = project();
    const a = pickGate();
    const b = pickGate();
    a.pick(p.save('#a00001'));
    a.pick(p.save('#a00002'));
    b.pick(p.save('#b00001'));
    b.pick(p.save('#b00002'));
    expect(p.sent).toEqual(['#a00001', '#b00001']);
    // An Undo, or an edit made elsewhere, is about to be sent: the held steps go ahead of it.
    sendHeldPicks();
    expect(p.sent).toEqual(['#a00001', '#b00001', '#a00002', '#b00002']);
    sendHeldPicks();
    // Sent once: answering the saves before them sends nothing more.
    for (let i = 0; i < 4; i++) await p.land();
    expect(p.sent).toHaveLength(4);
  });

  it('sends held steps in the order they were picked, though each one’s save asks for the held steps again', async () => {
    const p = project();
    const a = pickGate();
    const b = pickGate();
    a.pick(p.save('#a00001', true));
    b.pick(p.save('#b00001', true));
    a.pick(p.save('#a00002', true));
    b.pick(p.save('#b00002', true));
    // Sending A's step sends an edit, which asks for the held steps again: B's must not go ahead of A's.
    sendHeldPicks();
    expect(p.sent).toEqual(['#a00001', '#b00001', '#a00002', '#b00002']);
    for (let i = 0; i < 4; i++) await p.land();
    // A step that replaces a held one takes the newest place: B's, held since, goes first.
    a.pick(p.save('#a00003', true));
    b.pick(p.save('#b00003', true));
    a.pick(p.save('#a00004', true));
    b.pick(p.save('#b00004', true));
    a.pick(p.save('#a00005', true));
    sendHeldPicks();
    expect(p.sent.slice(6)).toEqual(['#b00004', '#a00005']);
  });

  it('sends the steps held on other swatches before them when a swatch’s save is answered first', async () => {
    const p = project();
    const [a, b, c] = [pickGate(), pickGate(), pickGate()];
    a.pick(p.save('#a00001', true));
    b.pick(p.save('#b00001', true));
    c.pick(p.save('#c00001', true));
    b.pick(p.save('#b00002', true));
    a.pick(p.save('#a00002', true));
    c.pick(p.save('#c00002', true));
    // A's save is answered first: B's step, picked before A's, goes ahead of it; C's, picked after, waits for C's save.
    await p.land();
    expect(p.sent).toEqual(['#a00001', '#b00001', '#c00001', '#b00002', '#a00002']);
  });

  it('keeps a settle waiting until the last step has been answered', async () => {
    const p = project();
    const gate = pickGate();
    gate.pick(p.save('#100000'));
    gate.pick(p.save('#200000'));
    let landed = false;
    void appliesLanded().then(() => (landed = true));
    expect(savesInFlight()).toBe(1);
    await p.land();
    await tick();
    // The first save has been answered but the second is on its way: the settle is still waiting for it.
    expect(landed).toBe(false);
    await p.land();
    await tick();
    expect(landed).toBe(true);
    expect(savesInFlight()).toBe(0);
  });
});
