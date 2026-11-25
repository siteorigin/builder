import { describe, expect, it } from 'vitest';
import { estimateRequestTokens } from '@agent/budget';
import type { CanonicalModelRequest, ModelCapabilities } from '@agent/types';
import { runCase, ScriptedAdapter, type EvalCase } from '../../scripts/eval/harness';
import { headroomWarning, LOCAL_OVERHEAD_TOKENS, messageRoom } from '../../src/renderer/src/lib/chatHeadroom';

/** What the first request of a page edit really takes besides its one-word message, with the tools a local model gets. */
async function overhead(caps: Partial<ModelCapabilities>, route: string): Promise<number> {
  let first: CanonicalModelRequest | undefined;
  const c: EvalCase = { id: 'measure', version: 1, category: 'page', prompt: 'x', pageScope: route, grade: () => [], script: () => [] };
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
const warn = (draft: string, o: Partial<Parameters<typeof headroomWarning>[0]> = {}) => headroomWarning({ draft, history: [], contextWindow: null, toolMode: 'auto', ...o });

describe('composer headroom for a local model', () => {
  it('reserves at least what the instructions, tools and editor context take, and not much more', async () => {
    const modes: Array<[keyof typeof LOCAL_OVERHEAD_TOKENS, Partial<ModelCapabilities>]> = [
      ['constrained', { toolCalling: 'constrained-json', contextWindowTokens: 32_768 }],
      ['focused', { toolCalling: 'native', contextWindowTokens: 32_768 }],
      ['general', { toolCalling: 'native', contextWindowTokens: 65_536 }]
    ];
    // Home has the most sections of the starter's pages, so the most editor context.
    for (const route of ['/', '/about/'])
      for (const [mode, caps] of modes) {
        const used = await overhead(caps, route);
        expect(used, `${mode} on ${route}`).toBeLessThanOrEqual(LOCAL_OVERHEAD_TOKENS[mode]);
        expect(LOCAL_OVERHEAD_TOKENS[mode] - used, `${mode} on ${route}`).toBeLessThan(1536);
      }
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
