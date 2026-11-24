/**
 * The composer answers the question the AI is waiting on (issue #22): which question that is, what Enter does
 * with the composer's text, and how a turn's earlier questions and answers are shown.
 */
import { describe, expect, it } from 'vitest';
import type { ChatMessage, Conversation } from '@shared/api';
import { composerAction, imageLabels, isPaused, isStarting, offeredImages, questionHint, shownQuestions, waitingQuestion } from '../../src/renderer/src/lib/chatQuestions';

const t = '2026-11-20T09:00:00.000Z';
const audience = { id: 'q_1', text: 'Who is the page for?', choices: ['New clients', 'Both equally'], answered: 'Both equally' };
const tone = { id: 'q_2', text: 'Which tone?', choices: ['Warm', 'Calm'] };
const turn = (extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: 'm_a', role: 'assistant', text: '', time: t, runId: 'run_1', activities: [], questions: [audience, tone], ...extra });
const conv = (...messages: ChatMessage[]): Conversation => ({ id: 'c_1', title: 'Contact', createdAt: t, messages: [{ id: 'm_u', role: 'user', text: 'Interview me', time: t }, ...messages] });

describe('the question the composer answers', () => {
  it('is the last unanswered question of the active run while it waits for input', () => {
    expect(waitingQuestion(conv(turn()), 'run_1', 'awaiting-input')).toEqual({ runId: 'run_1', messageId: 'm_a', question: tone });
    // An earlier turn's unanswered question (a stopped request) is never the one waiting.
    const earlier = turn({ id: 'm_old', runId: 'run_0', questions: [{ id: 'q_0', text: 'Old?', choices: [] }] });
    expect(waitingQuestion(conv(earlier, turn()), 'run_1', 'awaiting-input')?.question.id).toBe('q_2');
  });

  it('is none while the run works, for another run, once answered, after the result, or without an ID', () => {
    expect(waitingQuestion(conv(turn()), 'run_1', 'running')).toBeNull();
    expect(waitingQuestion(conv(turn()), 'run_1', 'stopping')).toBeNull();
    expect(waitingQuestion(conv(turn()), 'run_2', 'awaiting-input')).toBeNull();
    expect(waitingQuestion(conv(turn({ questions: [audience, { ...tone, answered: 'Calm' }] })), 'run_1', 'awaiting-input')).toBeNull();
    expect(waitingQuestion(conv(turn({ result: { status: 'cancelled', summary: 'Stopped.', changes: [], validation: [], canUndo: false } })), 'run_1', 'awaiting-input')).toBeNull();
    // A question stored by an earlier version has no ID, so nothing can answer it.
    expect(waitingQuestion(conv(turn({ questions: undefined, question: { text: 'Which tone?', choices: [] } })), 'run_1', 'awaiting-input')).toBeNull();
    expect(waitingQuestion(null, 'run_1', 'awaiting-input')).toBeNull();
  });

  it('answers on Enter when the box has text, and sends nothing for an empty box', () => {
    expect(composerAction({ text: 'Calm and understated', waiting: true, running: true })).toBe('answer');
    expect(composerAction({ text: '   \n', waiting: true, running: true })).toBe('none');
    // Back to ordinary chat once the question is answered: held while the run works, sent after it ends.
    expect(composerAction({ text: 'Now the footer', waiting: false, running: true })).toBe('hold');
    expect(composerAction({ text: 'Now the footer', waiting: false, running: false })).toBe('send');
    expect(composerAction({ text: '', waiting: false, running: false })).toBe('none');
  });

  it('never sends the message that comes back with an Enter pressed right after a typed answer', () => {
    expect(composerAction({ text: 'Now the footer', waiting: false, running: false, sinceAnswerMs: 200 })).toBe('none');
    expect(composerAction({ text: 'Now the footer', waiting: false, running: false, sinceAnswerMs: 900 })).toBe('none');
    expect(composerAction({ text: 'Now the footer', waiting: false, running: false, sinceAnswerMs: 1500 })).toBe('send');
    // A second answer is never held back.
    expect(composerAction({ text: 'Calm', waiting: true, running: true, sinceAnswerMs: 200 })).toBe('answer');
  });
});

describe('a turn shows every question it asked', () => {
  it('lists answered questions in order and leaves the waiting one to the composer', () => {
    const m = turn();
    const waiting = waitingQuestion(conv(m), 'run_1', 'awaiting-input');
    expect(shownQuestions(m, waiting).map((q) => [q.text, q.answered])).toEqual([[audience.text, 'Both equally']]);
    // Once the run is no longer waiting on it (stopped), the question shows as not answered.
    expect(shownQuestions(m, null).map((q) => [q.text, q.answered])).toEqual([
      [audience.text, 'Both equally'],
      [tone.text, undefined]
    ]);
  });

  it('leaves out a malformed stored question', () => {
    const m = turn({ questions: [null as never, { text: 'Kept?', choices: [], answered: 'Yes' }] });
    expect(shownQuestions(m, null).map((q) => q.text)).toEqual(['Kept?']);
  });

  it('shows a question stored by an earlier version', () => {
    const m = turn({ questions: undefined, question: { text: 'Which tone?', choices: ['Calm'], answered: 'Calm' } });
    expect(shownQuestions(m, null)).toEqual([{ text: 'Which tone?', choices: ['Calm'], answered: 'Calm', key: 'm_a:0' }]);
  });
});

describe('a turn paused for the author', () => {
  it('is the one holding the question, or the live turn of a run that waits', () => {
    const asking = waitingQuestion(conv(turn()), 'run_1', 'awaiting-input');
    expect(isPaused(asking, 'm_a', true, true)).toBe(true);
    // The question message may arrive before the status, or the status before the question.
    expect(isPaused(asking, 'm_a', false, false)).toBe(true);
    expect(isPaused(null, 'm_a', true, true)).toBe(true);
    expect(isPaused(null, 'm_a', true, false)).toBe(false);
    // An earlier turn of a waiting run is finished, not paused.
    expect(isPaused(asking, 'm_old', false, true)).toBe(false);
  });
});

describe('the "Getting started" spinner', () => {
  it('shows for a live turn with nothing yet, and never while that turn waits for the author', () => {
    const empty = turn({ activities: [] });
    expect(isStarting(empty, true, false)).toBe(true);
    // A question with no activity rows is a turn waiting on the author: nothing may keep spinning.
    expect(isStarting(empty, true, true)).toBe(false);
    expect(isStarting(empty, false, false)).toBe(false);
    expect(isStarting(turn({ text: 'Looking' }), true, false)).toBe(false);
    expect(isStarting(turn({ activities: [{ id: 'a', label: 'Reading', status: 'done' }] }), true, false)).toBe(false);
  });
});

describe('questions that offer library images (#12)', () => {
  it('names each picture, and adds the asset ID only where another shown with it, or in the library, has the same name', () => {
    expect(
      imageLabels([
        { assetId: 'a_yca1j3rh', name: 'hero' },
        { assetId: 'a_hodln13r', name: 'Hero ' },
        { assetId: 'a_kitchen', name: 'Kitchen' }
      ])
    ).toEqual([
      { assetId: 'a_yca1j3rh', name: 'hero', label: 'hero (a_yca1j3rh)', sharedName: true },
      { assetId: 'a_hodln13r', name: 'Hero ', label: 'Hero (a_hodln13r)', sharedName: true },
      { assetId: 'a_kitchen', name: 'Kitchen', label: 'Kitchen', sharedName: false }
    ]);
    // One "hero" attached while another is in the library: still told apart. The same image listed twice is not a clash.
    const library = [
      { assetId: 'a_yca1j3rh', name: 'hero' },
      { assetId: 'a_hodln13r', name: 'hero' },
      { assetId: 'a_nook', name: 'Reading nook' }
    ];
    expect(imageLabels([{ assetId: 'a_hodln13r', name: 'hero' }], library)).toEqual([{ assetId: 'a_hodln13r', name: 'hero', label: 'hero (a_hodln13r)', sharedName: true }]);
    expect(imageLabels([{ assetId: 'a_nook', name: 'Reading nook' }], library)).toEqual([{ assetId: 'a_nook', name: 'Reading nook', label: 'Reading nook', sharedName: false }]);
    // A hand-edited library name that is not text clashes with nothing and breaks nothing.
    expect(imageLabels([{ assetId: 'a_1', name: 'hero' }], [{ assetId: 'a_odd', name: 42 as never }, { assetId: 'a_odd2', name: 42 as never }])).toEqual([{ assetId: 'a_1', name: 'hero', label: 'hero', sharedName: false }]);
  });

  it('reads the offered pictures of a saved question in order, leaving out anything malformed', () => {
    expect(offeredImages({ images: [{ assetId: 'a_1', name: 'hero' }, null, { assetId: 7, name: 'x' }, { assetId: 'a_x' }, { assetId: 'a_2', name: 'hero' }] as never })).toEqual([
      { assetId: 'a_1', name: 'hero' },
      { assetId: 'a_2', name: 'hero' }
    ]);
    expect(offeredImages({})).toEqual([]);
    expect(offeredImages({ images: 'a_1' as never })).toEqual([]);
  });

  it('says how a picture question is answered, and keeps the other hints', () => {
    const img = [{ assetId: 'a_1', name: 'hero' }];
    expect(questionHint({ choices: [], images: img })).toBe('Choose a picture, or type your own answer below. Preview shows a picture larger before you choose.');
    expect(questionHint({ choices: ['Keep it'], images: img })).toBe('Choose a picture or an option, or type your own answer below. Preview shows a picture larger before you choose.');
    expect(questionHint({ choices: ['A'] })).toBe('Choose an option, or type your own answer below.');
    expect(questionHint({ choices: [] })).toBe('Type your answer below.');
    expect(questionHint({ choices: ['Yes', 'No'], widen: true })).toBe('Choose an option, or type a reply below. Only the first option, or a plain “yes”, allows the wider change.');
  });

  it('shows an answered picture question in the turn like any other', () => {
    const asked = { id: 'q1', text: 'Which photo?', choices: ['Keep it'], images: [{ assetId: 'a_1', name: 'hero' }, { assetId: 'a_2', name: 'hero' }], answered: 'hero', answeredAssetId: 'a_2' };
    const m: ChatMessage = { id: 'm1', role: 'assistant', text: '', time: '', questions: [asked] };
    expect(shownQuestions(m, null)).toEqual([{ ...asked, key: 'q1' }]);
  });
});
