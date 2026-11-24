import { afterEach, describe, expect, it } from 'vitest';
import { CANVAS_DRAFT, CODE_DRAFT, PAGE_ADD_DRAFT, afterSettle, draftCount, isSettling, reportRefused, resetPendingForTests, savesInFlight, setCanvasCommit, setDraft, settle, trackApply, type ApplyOutcome } from '../../src/renderer/src/lib/pending';
import { announcementText, saveStatusAnnouncement } from '../../src/renderer/src/lib/announce';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const deferred = () => {
  let resolve!: (o: ApplyOutcome) => void;
  const promise = new Promise<ApplyOutcome>((r) => (resolve = r));
  return { promise, resolve };
};

afterEach(() => resetPendingForTests());

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
    let release!: () => void;
    const queued = new Promise<void>((r) => (release = r));
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
    release();
    const { problems, finish } = await run;
    finish();
    expect(problems).toEqual([]);
  });

  it('reports a barrier that fails, and a refusal heard while waiting for it', async () => {
    const run = settle({
      blur: () => undefined,
      wait,
      barrier: async () => {
        reportRefused('That anchor is already used on this page.');
        throw new Error('The project was closed.');
      }
    });
    const { problems, finish } = await run;
    finish();
    expect(problems).toEqual(['That anchor is already used on this page.', 'A change could not be confirmed as saved.']);
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
