/**
 * Where the next AI message goes, and what it carries (issue #86): the next-message selector is told apart from the
 * model a turn went to, and a message to a model that has not seen the conversation's recent messages says so.
 */
import { describe, expect, it } from 'vitest';
import type { ChatMessage, ProviderStatus } from '@shared/api';
import type { TurnModel } from '@shared/turn-model';
import { REPLAYED_MESSAGES } from '@shared/turn-model';
import { nextRecipient, recipientText, sameRecipient, switchNotice, switchNoticeText, turnRecipient } from '../../src/renderer/src/lib/chatRecipient';

const t = '2026-11-24T09:00:00.000Z';
const A: TurnModel = { provider: 'local', id: 'studio-a', label: 'studio-a' };
const B: TurnModel = { provider: 'local', id: 'studio-b', label: 'studio-b' };
const SOL: TurnModel = { provider: 'openai', id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol' };
const SONNET: TurnModel = { provider: 'anthropic', id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' };

let n = 0;
/** One request and its turn, handled by `model` (none: the turn never reached a model, or predates the stamp). */
const exchange = (model?: unknown, extra: Partial<ChatMessage> = {}): ChatMessage[] => {
  n++;
  return [
    { id: `u${n}`, role: 'user', text: `note ${n}`, time: t },
    { id: `a${n}`, role: 'assistant', text: '', time: t, runId: `run_${n}`, ...(model !== undefined ? { model: model as TurnModel } : {}), result: { status: 'no-changes', summary: 'Done.', changes: [], validation: [], canUndo: false }, ...extra }
  ];
};

const openai: Pick<ProviderStatus, 'id' | 'models'> = { id: 'openai', models: [{ id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol' }] };
const anthropic: Pick<ProviderStatus, 'id' | 'models'> = { id: 'anthropic', models: [{ id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' }] };
const local: Pick<ProviderStatus, 'id' | 'models'> = { id: 'local', models: [] };
const models = (m: Partial<Record<'openai' | 'anthropic' | 'local', string>>) => ({ openai: 'gpt-6.2-sol', anthropic: 'claude-sonnet-5-5', local: '', ...m });
const toLocal = (id: string) => nextRecipient(local, models({ local: id }))!;

describe('the next message recipient', () => {
  it('comes from Settings, with the model labelled as Settings list it', () => {
    expect(nextRecipient(openai, models({}))).toEqual({ provider: 'openai', id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol' });
    expect(recipientText(nextRecipient(openai, models({}))!)).toBe('OpenAI · GPT-6.2 Sol');
    // A custom model ID is shown as typed.
    expect(recipientText(nextRecipient(openai, models({ openai: 'gpt-custom' }))!)).toBe('OpenAI · gpt-custom');
    expect(recipientText(toLocal('studio-b'))).toBe('Local model · studio-b');
    // No local model chosen: the server picks its own, which is not known until a turn runs.
    expect(toLocal('')).toEqual({ provider: 'local', id: null, label: "server's model" });
    expect(recipientText(toLocal(''))).toBe("Local model · server's model");
    expect(nextRecipient(undefined, models({}))).toBeNull();
    expect(recipientText(nextRecipient(anthropic, models({}))!)).toBe('Anthropic · Claude Sonnet 5.5');
    // A blank choice is no choice.
    expect(toLocal('   ').id).toBeNull();
  });

  it('names the model a local server offers first when Settings leave the choice to it', () => {
    expect(nextRecipient(local, models({ local: '' }), 'studio-b')).toEqual({ provider: 'local', id: 'studio-b', label: 'studio-b' });
    expect(recipientText(nextRecipient(local, models({ local: '' }), 'studio-b')!)).toBe('Local model · studio-b');
    // Unknown (the server did not answer) or blank: still the server's model.
    expect(nextRecipient(local, models({ local: '' }), null)?.id).toBeNull();
    expect(nextRecipient(local, models({ local: '' }), '  ')?.id).toBeNull();
    // A model chosen in Settings wins, and only a local server is asked.
    expect(nextRecipient(local, models({ local: 'studio-a' }), 'studio-b')?.id).toBe('studio-a');
    expect(nextRecipient(openai, models({}), 'studio-b')?.id).toBe('gpt-6.2-sol');
  });

  it('matches a turn by provider and model ID, and an automatic local pick only another automatic one', () => {
    expect(sameRecipient(A, toLocal('studio-a'))).toBe(true);
    expect(sameRecipient(A, toLocal('studio-b'))).toBe(false);
    // Matched by ID, never by name.
    expect(sameRecipient({ ...A, label: 'studio-b' }, toLocal('studio-b'))).toBe(false);
    expect(sameRecipient(SOL, nextRecipient(openai, models({}))!)).toBe(true);
    expect(sameRecipient(SOL, nextRecipient(anthropic, models({}))!)).toBe(false);
    // The same ID under another provider is another model.
    expect(sameRecipient({ provider: 'local', id: 'gpt-6.2-sol', label: 'gpt-6.2-sol' }, nextRecipient(openai, models({}))!)).toBe(false);
    // An explicit choice changed to "Use the server's model" is a switch; the server picking again is not.
    expect(sameRecipient(A, toLocal(''))).toBe(false);
    expect(sameRecipient({ ...B, auto: true }, toLocal(''))).toBe(true);
    // A turn the server picked studio-b for matches studio-b chosen by name, and nothing else.
    expect(sameRecipient({ ...B, auto: true }, toLocal('studio-b'))).toBe(true);
    expect(sameRecipient({ ...B, auto: true }, toLocal('studio-a'))).toBe(false);
  });

  it('reads a turn model only from an assistant turn, and never a malformed one', () => {
    const [user, turn] = exchange(A);
    expect(turnRecipient(turn)).toEqual(A);
    expect(turnRecipient({ ...user, model: A })).toBeNull();
    expect(turnRecipient(exchange({ provider: 'local', id: '' })[1])).toBeNull();
    expect(turnRecipient(exchange()[1])).toBeNull();
    expect(turnRecipient(null)).toBeNull();
  });
});

describe('the notice before a message goes to another model', () => {
  it('appears when the conversation so far went to a local model and the next message goes to a hosted one', () => {
    const notice = switchNotice([...exchange(A)], nextRecipient(openai, models({})));
    expect(notice).toMatchObject({ earlier: [A], unknown: false, leavesComputer: true });
    expect(switchNoticeText(notice!)).toBe('Your next message goes to OpenAI · GPT-6.2 Sol with recent messages from your conversation with Local model · studio-a. Those messages leave this computer.');
  });

  it('appears from hosted to local, and between two local models, without the leaving-this-computer warning', () => {
    const toA = switchNotice([...exchange(SOL)], toLocal('studio-a'));
    expect(toA).toMatchObject({ earlier: [SOL], leavesComputer: false });
    expect(switchNoticeText(toA!)).toBe('Your next message goes to Local model · studio-a with recent messages from your conversation with OpenAI · GPT-6.2 Sol.');
    expect(switchNotice([...exchange(A)], toLocal('studio-b'))).toMatchObject({ earlier: [A], leavesComputer: false });
    // Hosted to another hosted provider is a switch too.
    expect(switchNotice([...exchange(SOL)], nextRecipient(anthropic, models({})))).toMatchObject({ earlier: [SOL], leavesComputer: false });
  });

  it('appears while a turn is still running with the model the next message no longer goes to', () => {
    const running = exchange(A, { result: undefined });
    expect(switchNotice(running, toLocal('studio-b'))?.earlier).toEqual([A]);
    // The running turn already went to the chosen model: nothing new reaches it.
    expect(switchNotice([...exchange(A), ...exchange(B, { result: undefined })], toLocal('studio-b'))).toBeNull();
  });

  it('is gone once the new model has handled a turn, which carried everything before it', () => {
    expect(switchNotice([...exchange(A), ...exchange(B)], toLocal('studio-b'))).toBeNull();
    // Switching back: only the turns after A's last one are new to A.
    const back = switchNotice([...exchange(A), ...exchange(SONNET), ...exchange(B), ...exchange(B)], toLocal('studio-a'));
    expect(back?.earlier).toEqual([B, SONNET]);
    expect(switchNoticeText(back!)).toContain('from your conversation with Local model · studio-b and Anthropic · Claude Sonnet 5.5.');
  });

  it('names each other model once, newest first', () => {
    const notice = switchNotice([...exchange(A), ...exchange(B), ...exchange(A)], nextRecipient(openai, models({})));
    expect(notice?.earlier).toEqual([A, B]);
    expect(switchNoticeText(notice!)).toContain('from your conversation with Local model · studio-a and Local model · studio-b.');
  });

  it('still warns after a turn its model never answered, which may not have reached it', () => {
    const stopped = { status: 'cancelled' as const, summary: 'Stopped.', changes: [], validation: [], canUndo: false };
    // A local prompt stopped before an answer, then the switch to OpenAI: that prompt was for the local model only.
    const local = switchNotice([...exchange({ ...A, unanswered: true }, { result: stopped })], nextRecipient(openai, models({})));
    expect(local).toMatchObject({ earlier: [{ ...A, unanswered: true }], leavesComputer: true });
    // B was sent A's conversation, but stopped before answering: B may not have it, so the next message to B warns.
    expect(switchNotice([...exchange(A), ...exchange({ ...B, unanswered: true }, { result: stopped })], toLocal('studio-b'))?.earlier).toEqual([A]);
    // An unanswered turn for the same model, with nothing else before it, is nothing new.
    expect(switchNotice([...exchange({ ...B, unanswered: true }, { result: stopped })], toLocal('studio-b'))).toBeNull();
    // Once B answers, it has everything before.
    expect(switchNotice([...exchange(A), ...exchange({ ...B, unanswered: true }, { result: stopped }), ...exchange(B)], toLocal('studio-b'))).toBeNull();
  });

  it('warns about messages no model is named for: never sent to one, or stored before turns named one', () => {
    const failed = { status: 'failed' as const, summary: 'Could not reach the local server.', changes: [], validation: [], canUndo: false };
    // A note that never reached a model (the local server was down), now going to OpenAI.
    const down = switchNotice([...exchange(SOL), ...exchange(undefined, { result: failed })], nextRecipient(openai, models({})));
    expect(down).toMatchObject({ earlier: [], unknown: true, leavesComputer: true });
    expect(switchNoticeText(down!)).toBe('Your next message goes to OpenAI · GPT-6.2 Sol with recent messages from your conversation. Those messages leave this computer.');
    // ...and a known earlier model is still named with it.
    expect(switchNotice([...exchange(A), ...exchange(undefined, { result: failed })], nextRecipient(openai, models({})))).toMatchObject({ earlier: [A], unknown: true });
    // A conversation from before turns were stamped, reopened: whoever had it, the next model may not.
    expect(switchNotice([...exchange(), ...exchange()], toLocal('studio-a'))).toMatchObject({ earlier: [], unknown: true, leavesComputer: false });
    // A malformed stamp read back from disk is unknown too.
    expect(switchNotice([...exchange({ provider: 'gemini', id: 'x' })], nextRecipient(openai, models({})))?.unknown).toBe(true);
    // Unknown turns the next model has since answered after are nothing new.
    expect(switchNotice([...exchange(), ...exchange(SOL)], nextRecipient(openai, models({})))).toBeNull();
  });

  it('follows an explicit local model changed to the server\'s own, but not the server picking again', () => {
    expect(switchNotice([...exchange(A)], toLocal(''))?.earlier).toEqual([A]);
    expect(switchNotice([...exchange({ ...A, auto: true })], toLocal(''))).toBeNull();
  });

  it('follows the server itself switching models once it says which one it runs now', () => {
    const serverNow = (id: string) => nextRecipient(local, models({ local: '' }), id);
    // The server picked studio-a last time and offers studio-b first now: studio-b has not seen the conversation.
    expect(switchNotice([...exchange({ ...A, auto: true })], serverNow('studio-b'))?.earlier).toEqual([{ ...A, auto: true }]);
    expect(switchNotice([...exchange({ ...A, auto: true })], serverNow('studio-a'))).toBeNull();
    // studio-a chosen by name before, and the server's own model is studio-a: the same model, nothing to say.
    expect(switchNotice([...exchange(A)], serverNow('studio-a'))).toBeNull();
  });

  it('warns about leaving this computer for any local turn it carries, not just the newest', () => {
    const notice = switchNotice([...exchange(A), ...exchange(SONNET)], nextRecipient(openai, models({})));
    expect(notice).toMatchObject({ earlier: [SONNET, A], leavesComputer: true });
    expect(switchNotice([...exchange(SONNET)], nextRecipient(openai, models({})))?.leavesComputer).toBe(false);
  });

  it('tells apart models with the same ID at different providers', () => {
    // The same ID and the same name, at two providers: two models.
    const localSol: TurnModel = { provider: 'local', id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol' };
    expect(switchNotice([...exchange(localSol), ...exchange(SOL)], nextRecipient(anthropic, models({})))?.earlier).toEqual([SOL, localSol]);
  });

  it('counts only the messages the next request carries', () => {
    const old = exchange(A);
    // Enough newer turns, all by the next model, push A's out of the replayed window.
    const newer = Array.from({ length: REPLAYED_MESSAGES / 2 }, () => exchange(B)).flat();
    expect(switchNotice([...old, ...newer], toLocal('studio-b'))).toBeNull();
    // A turn that is no longer replayed is not named, even when it is the only other model.
    const unknownNewer = Array.from({ length: REPLAYED_MESSAGES / 2 }, () => exchange()).flat();
    expect(switchNotice([...old, ...unknownNewer], toLocal('studio-b'))?.earlier).toEqual([]);
    expect(switchNotice([...old, ...unknownNewer.slice(2)], toLocal('studio-b'))?.earlier).toEqual([A]);
  });

  it('is absent with no conversation yet, or no provider chosen', () => {
    expect(switchNotice([], toLocal('studio-b'))).toBeNull();
    expect(switchNotice([...exchange(A)], null)).toBeNull();
    expect(switchNotice([...exchange(A)], toLocal('studio-a'))).toBeNull();
  });
});
