import { describe, expect, it } from 'vitest';
import { estimateRequestTokens } from '@agent/budget';
import { FOCUSED_WINDOW_TOKENS } from '@shared/tokens';
import type { CanonicalModelRequest, ModelCapabilities } from '@agent/types';
import { runCase, ScriptedAdapter, type EvalCase } from '../../scripts/eval/harness';
import type { ChatMessage } from '@shared/api';
import type { ProjectState } from '@shared/types';
import { headroomWarning, LOCAL_OVERHEAD_TOKENS, messageRoom, replayedWords, SMALL_OVERHEAD_TOKENS } from '../../src/renderer/src/lib/chatHeadroom';

/**
 * What the first request of a page edit (or, with `selected`, an edit of Home's first section) really takes besides
 * its one-word message, with the tools a local model gets.
 */
async function overhead(caps: Partial<ModelCapabilities>, route: string, selected = false): Promise<number> {
  let first: CanonicalModelRequest | undefined;
  const select = (s: ProjectState) => ({ ref: { owner: { kind: 'page' as const, id: s.site.homePageId }, instancePath: [], nodeId: s.pages[s.site.homePageId].rootIds[0] }, label: 'Hero' });
  const c: EvalCase = { id: 'measure', version: 1, category: 'page', prompt: 'x', ...(selected ? { selection: select } : { pageScope: route }), grade: () => [], script: () => [] };
  const capture = new ScriptedAdapter(
    [
      (req) => {
        first = req;
        return [{ type: 'done', stopReason: 'end', text: 'Done.', toolCalls: [] }];
      }
    ],
    caps
  );
  await runCase(c, { adapterName: 'measure', model: 'measure', provider: 'local', adapter: () => capture });
  return estimateRequestTokens(first!.system, first!.tools, first!.items, caps.toolCalling === 'constrained-json');
}

const a = (tokens: number) => 'a'.repeat(tokens * 4);
const warn = (draft: string, o: Partial<Parameters<typeof headroomWarning>[0]> = {}) => headroomWarning({ draft, history: [], contextWindow: null, toolMode: 'auto', pageTools: true, ...o });

describe('composer headroom for a local model', () => {
  it('reserves at least what the instructions, tools and editor context take, and not much more', async () => {
    const modes: Array<[keyof typeof LOCAL_OVERHEAD_TOKENS, Partial<ModelCapabilities>]> = [
      ['constrained', { toolCalling: 'constrained-json', contextWindowTokens: 32_768 }],
      ['focused', { toolCalling: 'native', contextWindowTokens: 32_768 }]
    ];
    // Home has the most sections of the starter's pages, so the most editor context.
    for (const route of ['/', '/about/']) {
      for (const [mode, caps] of modes) {
        const used = await overhead(caps, route);
        expect(used, `${mode} on ${route}`).toBeLessThanOrEqual(LOCAL_OVERHEAD_TOKENS[mode]);
        expect(LOCAL_OVERHEAD_TOKENS[mode] - used, `${mode} on ${route}`).toBeLessThan(1536);
      }
      // The full native set, from the focused cutoff up, leaves the half of the window and a reply free.
      const full = await overhead({ toolCalling: 'native', contextWindowTokens: FOCUSED_WINDOW_TOKENS }, route);
      expect(full + 1024, route).toBeLessThanOrEqual(FOCUSED_WINDOW_TOKENS / 2);
    }
    // An edit of a selection carries the small tools: the reserve holds the larger of the two kinds of model.
    const selection = Math.max(...(await Promise.all(modes.map(([, caps]) => overhead(caps, '/', true)))));
    expect(selection).toBeLessThanOrEqual(SMALL_OVERHEAD_TOKENS);
    expect(SMALL_OVERHEAD_TOKENS - selection).toBeLessThan(1536);
  }, 60000);

  it('gives the messages half the window, or less where the instructions leave less', () => {
    // Constrained JSON is what "auto" runs for a model with no profile of its own.
    expect(messageRoom(32_768, 'auto')).toBe(16_384);
    expect(messageRoom(32_768, 'constrained-json')).toBe(16_384);
    expect(messageRoom(8192, 'auto')).toBe(8192 - 3584 - 1024);
    // Native tools: the small set below 64,000 tokens, the full set from there.
    expect(messageRoom(12_288, 'native')).toBe(12_288 - 10_240 - 1024);
    expect(messageRoom(65_536, 'native')).toBe(32_768);
    expect(messageRoom(8192, 'native')).toBe(0);
    expect(messageRoom(8192, 'constrained-json')).toBe(8192 - 3584 - 1024);
    // From the focused cutoff up the full set leaves the half free; under it, the small set's reserve can bind.
    expect(messageRoom(FOCUSED_WINDOW_TOKENS, 'native')).toBe(FOCUSED_WINDOW_TOKENS / 2);
    expect(messageRoom(20_000, 'native')).toBe(20_000 - 10_240 - 1024);
    expect(messageRoom(20_000, 'auto')).toBe(10_000);
    // A request without the page tools (a selection, a component, a question) is charged its small tools only.
    expect(messageRoom(8192, 'native', false)).toBe(4096);
    expect(messageRoom(8193, 'native', false)).toBe(4096);
    expect(messageRoom(12_288, 'native', false)).toBe(6144);
    expect(messageRoom(6144, 'auto', false)).toBe(6144 - 3072 - 1024);
    expect(messageRoom(1024, 'native', false)).toBe(0);
  });

  it('charges the page tools only to a request that may build pages', () => {
    // "Change this heading" about a selection on a small native window fits; the same words for the whole page do not.
    expect(warn('Change this heading to Services', { contextWindow: 8192, toolMode: 'native', pageTools: false })).toBeNull();
    expect(warn('Change this heading to Services', { contextWindow: 8192, toolMode: 'native' })?.kind).toBe('setup');
    expect(warn(a(1500), { contextWindow: 12_288, toolMode: 'native', pageTools: false })).toBeNull();
    expect(warn(a(1500), { contextWindow: 12_288, toolMode: 'native' })?.kind).toBe('draft');
    // A window too small for any request says so, whatever the request is about.
    expect(warn('Hello', { contextWindow: 1024, pageTools: false })?.kind).toBe('setup');
  });

  it('replays what the assistant replays: the last messages, and the questions asked with their answers', () => {
    const msg = (role: ChatMessage['role'], text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: `m${Math.random()}`, role, text, time: '', ...extra });
    const answer = 'お'.repeat(5000);
    const words = replayedWords([
      msg('user', 'Build the services page'),
      msg('assistant', 'Built it.', { questions: [{ id: 'q1', text: 'Which services?', choices: ['Repairs', 'Checks'], answered: answer } as never, { id: 'q2', text: 'And the order?', choices: [] } as never] })
    ]);
    // A long answer is replayed cut short; an unanswered question still says what it asked.
    expect(words).toEqual(['Build the services page', 'Which services?', 'Repairs', 'Checks', answer.slice(0, 4000), 'And the order?', '', 'Built it.']);
    // Only the messages a request replays count: the oldest beyond them do not.
    const many = Array.from({ length: 30 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `message ${i}`));
    expect(replayedWords(many)).toEqual(many.slice(-12).map((m) => m.text));
    // A conversation saved before several questions existed asked its one question in `question`.
    expect(replayedWords([msg('assistant', 'Done.', { question: { id: 'q', text: 'Which page?', choices: ['Home'], answered: 'Home' } as never })])).toEqual(['Which page?', 'Home', 'Home', 'Done.']);
    // An answer long enough to tip a follow-up over is counted.
    const history = replayedWords([msg('assistant', 'Done.', { questions: [{ id: 'q', text: 'Paste it?', choices: [], answered: answer } as never] })]);
    expect(warn(a(3000), { contextWindow: 8192 })).toBeNull();
    expect(warn(a(3000), { contextWindow: 8192, history })?.kind).toBe('history');
  });

  it('says nothing while the message fits, and how to split it or make room once it does not', () => {
    expect(warn('')).toBeNull();
    expect(warn('   \n ')).toBeNull();
    // With no size set the default window is assumed, and said to be.
    expect(warn(a(16_384))).toBeNull();
    const over = warn(a(16_384) + 'a')!;
    expect(over).toMatchObject({ kind: 'draft', windowTokens: 32_768, roomTokens: 16_384, assumed: true, draftTokens: 16_385 });
    expect(over.text).toBe("This message is longer than the local model's assumed 32,768-token context leaves room for (about 16,384 tokens). Send the copy a few sections at a time, or load the model with a larger context and set that size in AI settings.");
    // A size set in Settings is the one used; an unusable one is not.
    expect(warn(a(3584))).toBeNull();
    expect(warn(a(3585), { contextWindow: 8192 })).toMatchObject({ kind: 'draft', windowTokens: 8192, assumed: false });
    expect(warn(a(3585), { contextWindow: 8192 })!.text).toContain('match that size in AI settings');
    expect(warn(a(3585), { contextWindow: 3 })).toBeNull();
    // Chinese, Japanese and Korean characters count a token each, as the assistant counts them.
    expect(warn('お'.repeat(16_384))).toBeNull();
    expect(warn('お'.repeat(16_385))?.kind).toBe('draft');
  });

  it('counts the earlier messages a request replays, and says to start a new conversation when they tip it over', () => {
    const history = [a(10_000), a(6000)];
    expect(warn(a(384), { history })).toBeNull();
    const tipped = warn(a(385), { history })!;
    expect(tipped).toMatchObject({ kind: 'history', draftTokens: 385, historyTokens: 16_000 });
    expect(tipped.text).toBe("With this conversation's earlier messages, this message may not fit the local model's assumed 32,768-token context. Start a new conversation and send it there, or send the copy a few sections at a time.");
    // A message too long on its own is said to be, whatever came before it.
    expect(warn(a(16_385), { history })?.kind).toBe('draft');
  });

  it('says when the window is too small for the instructions, whatever the message', () => {
    const tiny = warn('Hello', { contextWindow: 8192, toolMode: 'native' })!;
    expect(tiny).toMatchObject({ kind: 'setup', roomTokens: 0 });
    expect(tiny.text).toBe("The assistant's instructions fill most of the local model's 8,192-token context, so a request may not fit. To use it, load the model with a larger context and match that size in AI settings.");
  });
});
