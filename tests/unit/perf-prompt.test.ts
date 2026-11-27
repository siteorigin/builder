/**
 * The prompt bench's reading of a request (scripts/perf/prompt-cache.ts): blocks in the order a provider reads them,
 * Anthropic's prompt caching rule applied over a run's requests, and what a request shares with the one before it.
 */
import { describe, expect, it } from 'vitest';
import { changedParts, commonPrefix, PromptCache, renderMessages, renderResponses } from '../../scripts/perf/prompt-cache';

const tool = (name: string, description = 'x'.repeat(3000)) => ({ name, description, input_schema: { type: 'object', properties: {} } });
const marked = <T extends object>(block: T) => ({ ...block, cache_control: { type: 'ephemeral' } });
const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
const call = (id: string) => ({ role: 'assistant', content: [{ type: 'text', text: 'Reading.' }, { type: 'tool_use', id, name: 'read_page', input: {} }] });
const result = (...ids: string[]) => ({ role: 'user', content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: '{"ok":true}' })) });
const body = (over: Record<string, unknown>) => ({ model: 'claude-sonnet-5-5', tools: [tool('a'), tool('b')], system: 'You edit websites.', messages: [user('Hello')], ...over });
const size = (r: ReturnType<typeof renderMessages>, upTo = r.bytes.length) => r.bytes.slice(0, upTo).reduce((n, b) => n + b, 0);

describe('prompt bench: requests as a provider reads them', () => {
  it('reads tools, then system, then each message block, a marker making no difference to what is compared', () => {
    const plain = renderMessages(body({}));
    expect(plain.blocks.length).toBe(4);
    expect([plain.systemAt, plain.messagesAt]).toEqual([2, 3]);
    expect(plain.markers).toBe(0);
    expect(plain.breakpoints).toEqual([]);
    // The system as a string is the one text block it stands for; a marker moves the breakpoint, not the content.
    const blocks = renderMessages(body({ system: [marked({ type: 'text', text: 'You edit websites.' })] }));
    expect(blocks.hashes).toEqual(plain.hashes);
    expect(blocks.breakpoints).toEqual([2]);
    // A top-level marker caches the last block.
    const auto = renderMessages(body({ cache_control: { type: 'ephemeral' } }));
    expect(auto.breakpoints).toEqual([3]);
    expect(auto.markers).toBe(1);
  });

  it('counts a run of tool_use blocks, or of tool_result blocks, in one message as one position', () => {
    const r = renderMessages(body({ messages: [user('Go'), { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'a', input: {} }, { type: 'tool_use', id: 't2', name: 'a', input: {} }] }, result('t1', 't2')] }));
    expect(r.units.slice(r.messagesAt)).toEqual([3, 4, 4, 5, 5]);
  });

  it('reads a Responses request as tools, instructions and input items', () => {
    const r = renderResponses({ model: 'gpt-6.2-sol', instructions: 'Edit.', tools: [{ type: 'function', name: 'a' }], input: [{ role: 'user', content: 'Hi' }, { type: 'function_call', call_id: 'c', name: 'a', arguments: '{}' }] });
    expect(r.blocks.length).toBe(4);
    expect([r.systemAt, r.messagesAt]).toEqual([1, 2]);
  });
});

describe('prompt bench: Anthropic prompt caching', () => {
  it('keeps nothing without a marker, however stable the prefix', () => {
    const cache = new PromptCache();
    for (let i = 0; i < 3; i++) {
      const r = renderMessages(body({}));
      expect(cache.serve(r)).toEqual({ read: 0, write: 0, uncached: size(r), total: size(r) });
    }
  });

  it('writes up to each breakpoint and reads the longest kept prefix on the next turn', () => {
    const cache = new PromptCache();
    const sys = [marked({ type: 'text', text: 'You edit websites.' })];
    const first = renderMessages(body({ system: sys, messages: [user('Go')], cache_control: { type: 'ephemeral' } }));
    expect(cache.serve(first)).toEqual({ read: 0, write: size(first), uncached: 0, total: size(first) });
    // The next turn appends the model's call and its result: the whole of the first request is read back.
    const second = renderMessages(body({ system: sys, messages: [user('Go'), call('t1'), result('t1')], cache_control: { type: 'ephemeral' } }));
    expect(cache.serve(second)).toEqual({ read: size(first), write: size(second) - size(first), uncached: 0, total: size(second) });
  });

  it('reads only up to the first change: a tool that changed leaves nothing, a system breakpoint the tools and system', () => {
    const cache = new PromptCache();
    const sys = [marked({ type: 'text', text: 'You edit websites.' })];
    cache.serve(renderMessages(body({ system: sys, cache_control: { type: 'ephemeral' } })));
    const otherTool = renderMessages(body({ tools: [tool('a'), tool('b', 'changed '.repeat(400))], system: sys, cache_control: { type: 'ephemeral' } }));
    expect(cache.serve(otherTool).read).toBe(0);
    // A changed first message still reads the tools and system kept at the system's breakpoint.
    const otherMessage = renderMessages(body({ tools: [tool('a'), tool('b', 'changed '.repeat(400))], system: sys, messages: [user('Something else')], cache_control: { type: 'ephemeral' } }));
    const served = cache.serve(otherMessage);
    expect(served.read).toBe(size(otherMessage, otherMessage.messagesAt));
  });

  it('finds a kept prefix only among the 20 positions that end at a breakpoint, and keeps none shorter than the minimum', () => {
    const turns = (n: number) => Array.from({ length: n }, (_, i) => [call(`t${i}`), result(`t${i}`)]).flat();
    const first = renderMessages(body({ messages: [user('Go')], cache_control: { type: 'ephemeral' } }));
    // `extra` positions after the kept block: each turn adds three (the text, the call, the result), then single texts.
    const later = (extra: number) => {
      const texts = Array.from({ length: extra % 3 }, (_, i) => ({ role: i % 2 ? 'user' : 'assistant', content: [{ type: 'text', text: `note ${i}` }] }));
      return renderMessages(body({ messages: [user('Go'), ...turns(Math.floor(extra / 3)), ...texts], cache_control: { type: 'ephemeral' } }));
    };
    for (const [extra, reached] of [[18, true], [19, true], [20, false], [33, false]] as const) {
      const cache = new PromptCache();
      cache.serve(first);
      const r = later(extra);
      expect(r.units.at(-1)! - r.units[r.messagesAt]).toBe(extra);
      // The breakpoint is the first of its 20 positions: a block 19 before it is the farthest it reads.
      expect(cache.serve(r).read).toBe(reached ? size(first) : 0);
    }
    const tiny = new PromptCache();
    const short = renderMessages({ model: 'm', system: 'Hi', messages: [user('Go')], cache_control: { type: 'ephemeral' } });
    expect(tiny.serve(short)).toMatchObject({ read: 0, write: 0 });
    expect(tiny.serve(short)).toMatchObject({ read: 0, write: 0 });
  });
});

describe('prompt bench: what a request shares with the one before', () => {
  it('measures the identical leading blocks and names the part that changed', () => {
    const a = renderMessages(body({ messages: [user('Go')] }));
    const b = renderMessages(body({ messages: [user('Go'), call('t1'), result('t1')] }));
    expect(commonPrefix(null, a)).toBe(0);
    expect(commonPrefix(a, b)).toBe(size(a));
    expect(changedParts(a, b)).toEqual({ tools: false, system: false, history: false });
    const c = renderMessages(body({ system: 'Other instructions.', messages: [user('Changed'), call('t1'), result('t1')] }));
    expect(commonPrefix(b, c)).toBe(size(b, b.systemAt));
    expect(changedParts(b, c)).toEqual({ tools: false, system: true, history: true });
  });
});
