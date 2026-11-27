/**
 * The app's own dialog for an AI change to where contact forms send (#1130): it opens only for the app's question,
 * shows the review that question carries, and answers it once, Keep for anything but Allow, or not at all once the
 * question no longer waits.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import type { ChatQuestion, FormRoutingPrompt } from '@shared/api';
import { questionHint, type WaitingQuestion } from '../../src/renderer/src/lib/chatQuestions';
import { askRoutingDialog, routingAnswer, routingDialog, routingKey, routingQuestion, type RoutingQuestion } from '../../src/renderer/src/lib/formRoutingReview';

type Confirm = { id: number; title: string; key?: string; formRouting?: FormRoutingPrompt; resolve: (ok: boolean | null) => void };
type Store = {
  confirmDialog: (req: { title: string; body: string; confirmLabel: string; key?: string }) => Promise<boolean | null>;
  withdrawConfirm: (key: string) => void;
  getConfirm: () => Confirm | null;
  pendingConfirms: () => readonly Confirm[];
};
let store: Store;
beforeAll(async () => {
  (globalThis as unknown as { window: unknown }).window = { builder: { platform: 'test' } };
  store = (await import(/* @vite-ignore */ resolve('src/renderer/src/store.ts'))) as Store;
});

const review: FormRoutingPrompt = {
  forms: [{ title: '“Contact form” on “Home”', rows: [{ label: 'Sends to', before: 'https://forms.example.com/sales (Form endpoint URL)', after: 'https://evil.example/f (Form endpoint URL)' }] }]
};
const question = (extra: Partial<ChatQuestion> = {}): WaitingQuestion => ({
  runId: 'run_1',
  messageId: 'm_1',
  question: { id: 'q_1', text: 'Let the assistant change where your contact form sends visitors’ messages?', choices: ['Keep it as it is', 'Allow this change'], formRouting: review, ...extra }
});
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Opens the dialog through the real queue, recording each answer sent. */
function open(q: RoutingQuestion, answer: (runId: string, questionId: string, text: string) => Promise<boolean> = async () => true) {
  const sent: string[] = [];
  let failed = 0;
  const withdraw = askRoutingDialog(q, {
    confirm: store.confirmDialog as never,
    withdraw: store.withdrawConfirm,
    answer: (runId, questionId, text) => (sent.push(`${runId}:${questionId}:${text}`), answer(runId, questionId, text)),
    failed: () => failed++
  });
  return { sent, withdraw, failed: () => failed };
}

describe('the app’s dialog for where forms send', () => {
  it('is only for the app’s own question, which carries its review', () => {
    expect(routingQuestion(question())).not.toBeNull();
    expect(routingQuestion(question({ formRouting: undefined }))).toBeNull();
    expect(routingQuestion(null)).toBeNull();
    expect(questionHint(question().question)).toMatch(/Review the change/);
  });

  it('shows the review, with Keep as the safe choice and Allow as the question words it', () => {
    const q = routingQuestion(question())!;
    const d = routingDialog(q);
    expect(d).toMatchObject({ key: routingKey(q), title: 'Change where your form sends?', confirmLabel: 'Allow this change', cancelLabel: 'Keep it as it is', formRouting: review });
    expect(routingDialog(routingQuestion(question({ formRouting: { forms: [...review.forms, ...review.forms] } }))!).title).toBe('Change where your forms send?');
    expect(routingAnswer(q, true)).toBe('Allow this change');
    expect(routingAnswer(q, false)).toBe('Keep it as it is');
    // Escape, × or the backdrop keep it as it is.
    expect(routingAnswer(q, null)).toBe('Keep it as it is');
  });

  it('answers Allow once, only from the Allow button', async () => {
    const { sent } = open(routingQuestion(question())!);
    const shown = store.getConfirm()!;
    expect(shown.formRouting).toEqual(review);
    shown.resolve(true);
    shown.resolve(false);
    await tick();
    expect(sent).toEqual(['run_1:q_1:Allow this change']);
    expect(store.getConfirm()).toBeNull();
  });

  it('answers Keep when it is dismissed', async () => {
    const { sent } = open(routingQuestion(question())!);
    store.getConfirm()!.resolve(null);
    await tick();
    expect(sent).toEqual(['run_1:q_1:Keep it as it is']);
  });

  it('sends nothing once taken back, on screen or waiting behind another question', async () => {
    const shown = open(routingQuestion(question())!);
    shown.withdraw();
    await tick();
    expect(shown.sent).toEqual([]);
    expect(store.getConfirm()).toBeNull();

    const other = store.confirmDialog({ title: 'Something else', body: '', confirmLabel: 'OK' });
    const waiting = open(routingQuestion(question())!);
    expect(store.pendingConfirms().map((c) => c.title)).toEqual(['Something else', 'Change where your form sends?']);
    waiting.withdraw();
    expect(store.pendingConfirms().map((c) => c.title)).toEqual(['Something else']);
    store.getConfirm()!.resolve(true);
    expect(await other).toBe(true);
    await tick();
    expect(waiting.sent).toEqual([]);
  });

  it('says so when the answer could not be sent', async () => {
    const { sent, failed } = open(routingQuestion(question())!, async () => false);
    store.getConfirm()!.resolve(true);
    await tick();
    await tick();
    expect(sent).toHaveLength(1);
    expect(failed()).toBe(1);
  });
});

describe('withdrawConfirm', () => {
  it('takes back only the questions asked with its key', async () => {
    const keyed = store.confirmDialog({ title: 'Keyed', body: '', confirmLabel: 'OK', key: 'k1' });
    const plain = store.confirmDialog({ title: 'Plain', body: '', confirmLabel: 'OK' });
    store.withdrawConfirm('k1');
    expect(await keyed).toBeNull();
    expect(store.getConfirm()?.title).toBe('Plain');
    store.withdrawConfirm('k2');
    expect(store.getConfirm()?.title).toBe('Plain');
    store.getConfirm()!.resolve(false);
    expect(await plain).toBe(false);
  });
});
