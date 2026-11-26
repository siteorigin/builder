import { afterEach, describe, expect, it } from 'vitest';
import { CANVAS_DRAFT, CODE_DRAFT, PAGE_ADD_DRAFT, afterEditsSettle, afterLanding, afterSettle, draftCount, isSettling, refusedWithin, reportRefused, resetPendingForTests, retainRefused, savesInFlight, setCanvasCommit, setDraft, settle, trackApply, type ApplyOutcome } from '../../src/renderer/src/lib/pending';
import { announcementText, saveStatusAnnouncement } from '../../src/renderer/src/lib/announce';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const deferred = () => {
  let resolve!: (o: ApplyOutcome) => void;
  const promise = new Promise<ApplyOutcome>((r) => (resolve = r));
  return { promise, resolve };
};

afterEach(() => resetPendingForTests());

describe('refused text inside a list about to be replaced (#575)', () => {
  /** A field placed in one of two lists, as `revealable` reports it. */
  const field = (list: object) => ({ focus: () => undefined, isConnected: true, inside: (root: object) => root === list });
  const footer = {};
  const header = {};

  it('names the field in the list that keeps text it refused, until it is corrected or discarded', () => {
    const url = field(footer);
    setDraft('url', true);
    retainRefused('url', 'What you typed in Web address can’t be saved.', url);
    expect(refusedWithin(footer)).toEqual({ message: 'What you typed in Web address can’t be saved.', field: url });
    // Another list has nothing to settle.
    expect(refusedWithin(header)).toBeNull();
    retainRefused('url', null);
    expect(refusedWithin(footer)).toBeNull();
  });

  it('ignores a field that has gone, or whose draft is closed', () => {
    setDraft('gone', true);
    retainRefused('gone', 'What you typed in Label can’t be saved.', { ...field(footer), isConnected: false });
    retainRefused('closed', 'What you typed in Label can’t be saved.', field(footer));
    expect(refusedWithin(footer)).toBeNull();
  });
});

describe('an export settles pending edits first (#753)', () => {
  it('includes an inline edit still open on the canvas when the export was started', async () => {
    // The project as saved, and the canvas holding typed text not committed yet.
    const project = { heading: 'Welcome' };
    setDraft(CANVAS_DRAFT, true);
    setCanvasCommit(() =>
      setTimeout(() => {
        setDraft(CANVAS_DRAFT, false);
        trackApply(
          new Promise<ApplyOutcome>((r) =>
            setTimeout(() => {
              project.heading = 'Welcome aboard';
              r({ ok: true });
            }, 20)
          )
        );
      }, 30)
    );
    let exported: string | null = null;
    const started = await afterEditsSettle(
      () => settle({ blur: () => undefined, wait }),
      async () => (exported = project.heading)
    );
    expect(started).toEqual({ ok: true, value: 'Welcome aboard' });
    expect(exported).toBe('Welcome aboard');
    expect(isSettling()).toBe(false);
  });

  it('does not start when an edit can’t be saved, and says why', async () => {
    setDraft(CANVAS_DRAFT, true);
    setCanvasCommit(() => {
      setDraft(CANVAS_DRAFT, false);
      trackApply(Promise.resolve({ ok: false, message: 'That change could not be saved: ENOSPC' }));
    });
    let starts = 0;
    const started = await afterEditsSettle(
      () => settle({ blur: () => undefined, wait }),
      async () => ++starts
    );
    expect(started).toEqual({ ok: false, problems: ['That change could not be saved: ENOSPC'] });
    expect(starts).toBe(0);
    expect(isSettling()).toBe(false);
  });
});

describe('settling pending edits', () => {
  it('commits the focused field the way leaving it does, and waits for its change to land', async () => {
    const apply = deferred();
    setDraft('field', true);
    let landed = false;
    // Leaving the field (the blur) clears its draft and starts the change, as DraftInput does.
    const run = settle({
      blur: () => {
        setDraft('field', false);
        trackApply(apply.promise);
      },
      wait
    });
    void run.then(() => (landed = true));
    await wait(80);
    // Still waiting for the change, however long it takes.
    expect(landed).toBe(false);
    expect(savesInFlight()).toBe(1);
    apply.resolve({ ok: true });
    const { problems, finish } = await run;
    expect(landed).toBe(true);
    finish();
    expect(problems).toEqual([]);
    expect(draftCount()).toBe(0);
  });

  it('waits for a change started just before it, and reports that change failing', async () => {
    const earlier = deferred();
    trackApply(earlier.promise);
    const run = settle({ blur: () => undefined, wait });
    await wait(30);
    earlier.resolve({ ok: false, message: 'That anchor is already used on this page.' });
    const { problems, finish } = await run;
    finish();
    expect(problems).toEqual(['That anchor is already used on this page.']);
  });

  it('reports a change whose sending failed outright', async () => {
    const run = settle({ blur: () => trackApply(Promise.reject(new Error('IPC closed'))), wait });
    const { problems, finish } = await run;
    finish();
    expect(problems).toEqual(['IPC closed']);
  });

  it('reports a value a field refused itself (a page with no title)', async () => {
    const { problems, finish } = await settle({ blur: () => reportRefused('What you typed in Title can’t be saved.'), wait });
    finish();
    expect(problems).toEqual(['What you typed in Title can’t be saved.']);
  });

  it('ignores refusals and failures from ordinary editing, outside any settle', async () => {
    reportRefused('What you typed in Title can’t be saved.');
    const old = deferred();
    trackApply(old.promise);
    old.resolve({ ok: false, message: 'Refused earlier' });
    await wait(0);
    const { problems, finish } = await settle({ blur: () => undefined, wait });
    finish();
    expect(problems).toEqual([]);
  });

  it('asks the canvas to hand back an inline edit and waits for it and its change', async () => {
    setDraft(CANVAS_DRAFT, true);
    const apply = deferred();
    let asked = 0;
    setCanvasCommit(() => {
      asked++;
      // The preview answers a moment later; the canvas ends the edit and starts the change in one go.
      setTimeout(() => {
        setDraft(CANVAS_DRAFT, false);
        trackApply(apply.promise);
        setTimeout(() => apply.resolve({ ok: true }), 20);
      }, 40);
    });
    const { problems, finish } = await settle({ blur: () => undefined, wait });
    finish();
    expect(asked).toBe(1);
    expect(problems).toEqual([]);
    expect(savesInFlight()).toBe(0);
  });

  it('reports an inline edit the preview never handed back, and a change that never lands in the time given', async () => {
    setDraft(CANVAS_DRAFT, true);
    trackApply(new Promise<ApplyOutcome>(() => undefined));
    const { problems, finish } = await settle({ blur: () => undefined, wait, canvasTimeoutMs: 60, saveTimeoutMs: 60 });
    finish();
    expect(problems).toEqual(['A change is still being saved.', 'The text you are editing on the page has not been saved.']);
  });

  it('holds input only once the preview has handed back its edit, so a link being typed there keeps focus', async () => {
    const order: string[] = [];
    setDraft(CANVAS_DRAFT, true);
    setCanvasCommit(() =>
      setTimeout(() => {
        order.push('canvas answered');
        setDraft(CANVAS_DRAFT, false);
      }, 40)
    );
    const { finish } = await settle({ blur: () => order.push('blur'), hold: () => order.push('hold'), wait });
    finish();
    expect(order).toEqual(['blur', 'canvas answered', 'hold']);
  });

  it('names the field that refused its text, for Keep editing to return to, while it is on screen', async () => {
    const field = { focus: () => undefined, isConnected: true };
    const gone = { focus: () => undefined, isConnected: false };
    const first = await settle({ blur: () => reportRefused('What you typed in Title can’t be saved.', 'title', field), wait });
    first.finish();
    expect(first.refused).toBe(field);
    const second = await settle({ blur: () => reportRefused('What you typed in Title can’t be saved.', 'title', gone), wait });
    second.finish();
    expect(second.refused).toBeNull();
  });

  it('names a field still keeping text it refused before the settle began, and returns there', async () => {
    const url = { focus: () => undefined, isConnected: true };
    // Left earlier: the field kept the refused text as a draft, with its reason beside it.
    setDraft('url', true);
    retainRefused('url', 'What you typed in Public URL can’t be saved.', url);
    const first = await settle({ blur: () => undefined, wait });
    first.finish();
    expect(first.problems).toEqual(['What you typed in Public URL can’t be saved.']);
    expect(first.refused).toBe(url);
    // Corrected or discarded: an open draft is only an unsaved one, and nothing is returned to.
    retainRefused('url', null);
    const second = await settle({ blur: () => undefined, wait });
    second.finish();
    expect(second.problems).toEqual(['A change you were typing has not been saved.']);
    expect(second.refused).toBeNull();
  });

  it('names each field keeping a refusal, returns to the first, and forgets one whose draft has closed', async () => {
    const url = { focus: () => undefined, isConnected: true };
    const lang = { focus: () => undefined, isConnected: true };
    setDraft('url', true);
    retainRefused('url', 'What you typed in Public URL can’t be saved.', url);
    setDraft('lang', true);
    retainRefused('lang', 'What you typed in Language can’t be saved.', lang);
    // A field whose draft has gone (saved, or discarded with Escape) is not reported, whatever it registered.
    retainRefused('name', 'What you typed in Site name can’t be saved.', { focus: () => undefined, isConnected: true });
    const { problems, refused, finish } = await settle({ blur: () => undefined, wait });
    finish();
    expect(problems).toEqual(['What you typed in Public URL can’t be saved.', 'What you typed in Language can’t be saved.']);
    expect(refused).toBe(url);
  });

  it('lets a refusal made while leaving speak for its field, not the one it kept from before', async () => {
    const kept = { focus: () => undefined, isConnected: true };
    const now = { focus: () => undefined, isConnected: true };
    setDraft('url', true);
    retainRefused('url', 'Kept from before.', kept);
    const { problems, refused, finish } = await settle({ blur: () => reportRefused('Refused while leaving.', 'url', now), wait });
    finish();
    expect(problems).toEqual(['Refused while leaving.']);
    expect(refused).toBe(now);
  });

  it('reports unsaved code and a field typed in while it waited, but not a refusal twice', async () => {
    setDraft(CODE_DRAFT, true);
    setDraft('refusing-field', true);
    const late = deferred();
    trackApply(late.promise);
    const run = settle({ blur: () => reportRefused('What you typed in Title can’t be saved.', 'refusing-field'), wait });
    await wait(10);
    // Typed in another field before the earlier change landed.
    setDraft('other-field', true);
    late.resolve({ ok: true });
    const { problems, finish } = await run;
    finish();
    expect(problems).toEqual(['What you typed in Title can’t be saved.', 'Your code changes have not been saved.', 'A change you were typing has not been saved.']);
  });

  it('hears a refusal an overlapping settle heard first (Save, then Close before it finished)', async () => {
    const save = deferred();
    trackApply(save.promise);
    const field = { focus: () => undefined, isConnected: true };
    // The refusing field stays a draft while its text waits for the author.
    setDraft('title', true);
    const first = settle({ blur: () => reportRefused('What you typed in Title can’t be saved.', 'title', field), wait });
    await wait(10);
    const second = settle({ blur: () => undefined, wait });
    save.resolve({ ok: true });
    const [a, b] = await Promise.all([first, second]);
    a.finish();
    b.finish();
    // Said once (not again as an unsaved field), with the field to return to.
    expect(b.problems).toEqual(['What you typed in Title can’t be saved.']);
    expect(b.refused).toBe(field);
  });

  it('reports a page that was being added, since leaving its form never creates it', async () => {
    setDraft(PAGE_ADD_DRAFT, true);
    const { problems, finish } = await settle({ blur: () => undefined, wait });
    finish();
    expect(problems).toEqual(['The page you started adding has not been created yet.']);
  });

  it('lets an empty Add page form close on the blur without asking', async () => {
    setDraft(PAGE_ADD_DRAFT, true);
    // The form closes itself a moment after losing focus (a React update), not during the blur.
    const { problems, finish } = await settle({ blur: () => void setTimeout(() => setDraft(PAGE_ADD_DRAFT, false), 0), wait });
    finish();
    expect(problems).toEqual([]);
  });

  it('keeps typed text on screen until the author decides, then puts saved values back', async () => {
    const run = settle({ blur: () => afterSettle(() => reverted.push('field')), wait });
    const reverted: string[] = [];
    const { finish } = await run;
    expect(isSettling()).toBe(true);
    expect(reverted).toEqual([]);
    finish();
    finish();
    expect(reverted).toEqual(['field']);
    expect(isSettling()).toBe(false);
    // Outside a settle the saved value comes back straight away, as before.
    afterSettle(() => reverted.push('later'));
    expect(reverted).toEqual(['field', 'later']);
  });

  it('puts a field’s saved value back only once the change it started has landed, however long that takes', async () => {
    const reverted: string[] = [];
    // Nothing on its way: at once, as before.
    afterLanding(() => reverted.push('idle'));
    expect(reverted).toEqual(['idle']);
    // Left with its change still being saved (a slow disk, a preview still taking the save before it): the typed text
    // stays until the project holds it, never the value from before the change.
    const apply = deferred();
    trackApply(apply.promise);
    afterLanding(() => reverted.push('field'));
    await wait(500);
    expect(reverted).toEqual(['idle']);
    apply.resolve({ ok: true });
    await wait(0);
    expect(reverted).toEqual(['idle', 'field']);
    // A change refused puts it back too.
    const refused = deferred();
    trackApply(refused.promise);
    afterLanding(() => reverted.push('refused'));
    refused.resolve({ ok: false, message: 'That anchor is already used on this page.' });
    await wait(0);
    expect(reverted).toEqual(['idle', 'field', 'refused']);
  });

  it('puts it back after a settle too, once the change has landed', async () => {
    const reverted: string[] = [];
    const apply = deferred();
    const run = settle({
      blur: () => {
        trackApply(apply.promise);
        afterLanding(() => reverted.push('field'));
      },
      wait
    });
    apply.resolve({ ok: true });
    const { finish } = await run;
    expect(reverted).toEqual([]);
    finish();
    await wait(0);
    expect(reverted).toEqual(['field']);
  });

  it('runs overlapping settles (Save during a close) to their own answers, reverting after the last', async () => {
    const reverted: string[] = [];
    const first = await settle({ blur: () => afterSettle(() => reverted.push('a')), wait });
    const second = await settle({ blur: () => reportRefused('Refused during the second'), wait });
    expect(first.problems).toEqual([]);
    expect(second.problems).toEqual(['Refused during the second']);
    first.finish();
    expect(reverted).toEqual([]);
    second.finish();
    expect(reverted).toEqual(['a']);
  });
});

describe('the save barrier', () => {
  it('waits, after every tracked change has landed, for the barrier (the project’s queued writes) before it settles', async () => {
    const apply = deferred();
    trackApply(apply.promise);
    const order: string[] = [];
    let release!: (saved: boolean) => void;
    const queued = new Promise<boolean>((r) => (release = r));
    let settled = false;
    const run = settle({
      blur: () => undefined,
      wait,
      barrier: () => {
        order.push('barrier');
        return queued;
      }
    });
    void run.then(() => (settled = true));
    await wait(40);
    // Not before the tracked change: an edit still on its way would enter the queue after the barrier.
    expect(order).toEqual([]);
    apply.resolve({ ok: true });
    await wait(40);
    expect(order).toEqual(['barrier']);
    expect(settled).toBe(false);
    release(true);
    const { problems, finish } = await run;
    finish();
    expect(problems).toEqual([]);
  });

  it('skips the barrier when a change never landed in the time given', async () => {
    trackApply(new Promise<ApplyOutcome>(() => undefined));
    let called = 0;
    const { problems, finish } = await settle({ blur: () => undefined, wait, saveTimeoutMs: 60, barrier: async () => (called++, true) });
    finish();
    expect(called).toBe(0);
    expect(problems).toEqual(['A change is still being saved.']);
  });

  it('reports writes the barrier could not confirm, and a refusal heard while waiting for it', async () => {
    const run = settle({
      blur: () => undefined,
      wait,
      barrier: async () => {
        await wait(30);
        reportRefused('That anchor is already used on this page.');
        await wait(30);
        throw new Error('The project was closed.');
      }
    });
    const { problems, finish } = await run;
    finish();
    expect(problems).toEqual(['That anchor is already used on this page.', 'A change could not be confirmed as saved.']);
    const unsaved = await settle({ blur: () => undefined, wait, barrier: async () => false });
    unsaved.finish();
    expect(unsaved.problems).toEqual(['A change could not be confirmed as saved.']);
  });

  it('keeps its answer to itself: a Close running meanwhile is not told about Save’s confirmation', async () => {
    const save = settle({ blur: () => undefined, wait, barrier: () => new Promise<boolean>(() => undefined), barrierTimeoutMs: 80 });
    await wait(20);
    const close = settle({ blur: () => undefined, wait });
    const closed = await close;
    const saved = await save;
    closed.finish();
    saved.finish();
    expect(saved.problems).toEqual(['A change is still being saved.']);
    expect(closed.problems).toEqual([]);
  });

  it('keeps its answer to itself even from a Close that starts once the answer is in', async () => {
    let answered = false;
    let close: Promise<Awaited<ReturnType<typeof settle>>> | null = null;
    const save = settle({
      blur: () => undefined,
      // Close is chosen in the turn after Save heard that its writes could not be confirmed.
      wait: async (ms) => {
        if (answered && !close) close = settle({ blur: () => undefined, wait });
        await wait(ms);
      },
      barrier: async () => {
        answered = true;
        return false;
      }
    });
    const saved = await save;
    const closed = await close!;
    saved.finish();
    closed.finish();
    expect(saved.problems).toEqual(['A change could not be confirmed as saved.']);
    expect(closed.problems).toEqual([]);
  });

  it('treats a barrier that throws at once like one that fails', async () => {
    const { problems, finish } = await settle({
      blur: () => undefined,
      wait,
      barrier: () => {
        throw new Error('No project is open.');
      }
    });
    finish();
    expect(problems).toEqual(['A change could not be confirmed as saved.']);
    expect(isSettling()).toBe(false);
  });

  it('stops waiting for writes held up past its time, without confirming them', async () => {
    const started = Date.now();
    const { problems, finish } = await settle({ blur: () => undefined, wait, barrier: () => new Promise<boolean>(() => undefined), barrierTimeoutMs: 80 });
    finish();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(problems).toEqual(['A change is still being saved.']);
    expect(isSettling()).toBe(false);
  });
});

describe('save status announcements', () => {
  it('clears the saved message while a change is unsaved or saving, rather than keeping it', () => {
    expect(saveStatusAnnouncement('saved', 'busy')).toBe('');
    expect(announcementText('', 3)).toEqual({ text: '', count: 3 });
  });

  it('announces a save completing, again even when the words repeat', () => {
    expect(saveStatusAnnouncement('busy', 'saved')).toBe('All changes saved');
    expect(saveStatusAnnouncement('conflict', 'saved')).toBe('File conflict resolved. All changes saved');
    expect(saveStatusAnnouncement('working', 'saved')).toBe('AI changes saved');
    const first = announcementText('All changes saved', 0)!;
    const second = announcementText('All changes saved', first.count)!;
    expect(first.text).not.toBe(second.text);
    expect(second.text.trim()).toBe('All changes saved');
  });

  it('leaves the region alone when there is nothing to say', () => {
    expect(announcementText(null, 2)).toBeNull();
  });
});
