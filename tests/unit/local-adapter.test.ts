/** The local adapter against a real HTTP server speaking OpenAI-compatible SSE, including its failure shapes. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { contextOverflow, discoverLocalContext, LocalAdapter, listLocalModels, openLocalAdapter, testLocal, type LocalAdapterOptions, type LocalEndpoint } from '@agent/local';
import { envelopeSchema, parseEnvelope, partialStatus, signature } from '@agent/constrained';
import { dropEnumTypes, findForbiddenShapes, inlineDefinitions, OPEN_VALUE_KEY, toStrictSchema } from '@agent/strict-schema';
import { constrainedToolSets } from './fixtures/constrained-tools';
import { DEFAULT_LOCAL_PROFILE, localModelProfile, modelInfo } from '@agent/models';
import { toolDefinitions } from '@agent/tools';
import { fixComponentSource } from '@agent/fixer';
import { checkLocalBaseURL, LOCAL_CONTEXT_MAX, LOCAL_CONTEXT_MIN, LOCAL_PRESETS, localContextWindow, localKeyProblem, parseContextSize } from '@shared/local';
import type { CanonicalModelRequest, ModelEvent, ToolDefinition } from '@agent/types';
import { closedPort, DONE, envelopeReply, MockOpenAIServer, renderStrictTemplate, sseChunk, textReply, toolCallReply } from './mock-openai-server';

const TOOLS: ToolDefinition[] = [
  { name: 'read_page', description: 'Read a page', parameters: { type: 'object', properties: { pageId: { type: 'string' } }, required: ['pageId'] } },
  { name: 'set_value', description: 'Set a value', parameters: { type: 'object', properties: { value: {} }, required: ['value'] } }
];

const request = (over: Partial<CanonicalModelRequest> = {}): CanonicalModelRequest => ({ model: 'test-model', system: 'You edit websites.', items: [{ kind: 'user', text: 'Hello' }], tools: TOOLS, maxOutputTokens: 4000, ...over });

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}
const doneOf = (events: ModelEvent[]) => events.find((e) => e.type === 'done') as Extract<ModelEvent, { type: 'done' }>;
const errorOf = (events: ModelEvent[]) => events.find((e) => e.type === 'error') as Extract<ModelEvent, { type: 'error' }>;
const textOf = (events: ModelEvent[]) => events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('');

let server: MockOpenAIServer;
beforeEach(async () => {
  server = await new MockOpenAIServer().start();
});
afterEach(() => server.stop());

const adapter = (endpoint: Partial<LocalEndpoint> = {}, opts: LocalAdapterOptions = {}) => new LocalAdapter({ baseURL: server.baseURL, model: 'test-model', ...endpoint }, opts);
const native = (opts: LocalAdapterOptions = {}, endpoint: Partial<LocalEndpoint> = {}) => adapter({ toolMode: 'native', ...endpoint }, opts);
const run = (a: LocalAdapter, over: Partial<CanonicalModelRequest> = {}, signal = new AbortController().signal) => collect(a.streamTurn(request(over), signal));
const posts = () => server.requests.filter((r) => r.method === 'POST');

describe('streaming', () => {
  it('streams text to /chat/completions with no key required', async () => {
    server.script(textReply('Hello from a local model.'));
    const events = await run(native(), { tools: [] });
    expect(textOf(events)).toBe('Hello from a local model.');
    expect(doneOf(events)).toMatchObject({ stopReason: 'end', text: 'Hello from a local model.', toolCalls: [] });
    expect(posts()[0].url).toBe('/v1/chat/completions');
    expect(posts()[0].headers.authorization).toBeUndefined();
    expect(posts()[0].body).toMatchObject({ model: 'test-model', stream: true, max_tokens: 4000 });
    expect(posts()[0].body.messages[0]).toEqual({ role: 'system', content: 'You edit websites.' });
  });

  it('sends a configured key as a bearer token', async () => {
    server.script(textReply('ok'));
    await run(native({}, { apiKey: 'local-secret' }), { tools: [] });
    expect(posts()[0].headers.authorization).toBe('Bearer local-secret');
  });

  it('reads frames split across chunks, CRLF line endings and multi-byte characters', async () => {
    const frame = (content: string) => `data: ${JSON.stringify(sseChunk({ content }))}\r\n\r\n`;
    const bytes = Buffer.from(frame('héllo ') + frame('wörld 🌍') + `data: ${JSON.stringify(sseChunk({}, 'stop'))}\r\n\r\ndata: [DONE]\r\n\r\n`);
    const fetch = (async () =>
      new Response(
        new ReadableStream({
          start(c) {
            for (let i = 0; i < bytes.length; i += 3) c.enqueue(bytes.subarray(i, i + 3));
            c.close();
          }
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      )) as typeof globalThis.fetch;
    const events = await run(native({ fetch }), { tools: [] });
    expect(doneOf(events).text).toBe('héllo wörld 🌍');
  });

  it('handles missing usage, and reads a usage chunk after the finish reason', async () => {
    server.script(textReply('none'), textReply('some', { usage: { prompt_tokens: 12, completion_tokens: 3 } }));
    expect(doneOf(await run(native(), { tools: [] })).usage).toBeUndefined();
    expect(doneOf(await run(native(), { tools: [] })).usage).toEqual({ inputTokens: 12, outputTokens: 3 });
  });

  it('reports the prompt tokens a server reused from the request before, when it says (#977)', async () => {
    server.script(textReply('some', { usage: { prompt_tokens: 4000, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 3800 } } }));
    expect(doneOf(await run(native(), { tools: [] })).usage).toEqual({ inputTokens: 4000, outputTokens: 3, cachedInputTokens: 3800 });
  });

  it('asks again after a garbled frame, which may have held part of a call', async () => {
    server.script({ frames: [sseChunk({ content: 'Good' }), 'data: {not json\n\n', sseChunk({ content: ' reply' }), sseChunk({}, 'stop'), DONE] }, textReply('Whole reply'));
    expect(doneOf(await run(native(), { tools: [] })).text).toBe('Whole reply');
    expect(posts()).toHaveLength(2);
  });

  it('reads CR-only line endings and a named error event', async () => {
    const frame = (v: unknown) => `data: ${JSON.stringify(v)}\r\r`;
    server.script({ frames: [frame(sseChunk({ content: 'cr' })), frame(sseChunk({}, 'stop')), 'data: [DONE]\r\r'] }, { frames: [sseChunk({ content: 'x' }), sseChunk({}, 'stop'), 'event: error\ndata: {"message":"slot crashed"}\n\n', DONE] });
    expect(doneOf(await run(native(), { tools: [] })).text).toBe('cr');
    const events = await run(native(), { tools: [] });
    expect(doneOf(events)).toBeUndefined();
    expect(errorOf(events).message).toMatch(/slot crashed/);
  });

  it('finishes on a CR-only frame even when the server leaves the stream open', async () => {
    const frame = (v: unknown) => `data: ${JSON.stringify(v)}\r\r`;
    server.script({ frames: [frame(sseChunk({ content: 'cr' })), frame(sseChunk({}, 'stop'))], keepOpen: true });
    expect(doneOf(await run(native({ idleTimeoutMs: 5000 }), { tools: [] })).text).toBe('cr');
  });

  it('treats a frame of the wrong shape as garbled', async () => {
    server.script({ frames: [sseChunk({ content: 'Good' }), 'data: []\n\n', sseChunk({}, 'stop'), DONE] }, textReply('Whole reply'));
    expect(doneOf(await run(native(), { tools: [] })).text).toBe('Whole reply');
    expect(posts()[1].body.messages.at(-1).content).not.toContain('JSON');
  });

  it('rejects reasoning or an empty finish reason after the reply ended', async () => {
    server.script({ frames: [sseChunk({ content: 'x' }), sseChunk({}, 'stop'), sseChunk({ reasoning_content: 'more' }), DONE] }, { frames: [sseChunk({ content: 'x' }), sseChunk({}, 'stop'), sseChunk({}, ''), DONE] });
    expect(doneOf(await run(native(), { tools: [] }))).toBeUndefined();
    expect(doneOf(await run(native(), { tools: [] }))).toBeUndefined();
  });

  it('never treats a reply without a recognized finish as complete', async () => {
    const call = sseChunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 'read_page', arguments: '{"pageId":"p"}' } }] });
    server.script({ frames: [call, DONE] }, { frames: [call, sseChunk({}, 'error'), DONE] }, { frames: [call, sseChunk({}, 'stop'), sseChunk({}, 'length'), DONE] }, { frames: [call, sseChunk({}, 'stop'), sseChunk({ content: 'more' }), DONE] });
    for (let i = 0; i < 4; i++) {
      const events = await run(native());
      expect(doneOf(events), `case ${i}`).toBeUndefined();
      expect(errorOf(events), `case ${i}`).toBeDefined();
    }
  });

  it('does not let empty fragments keep a stalled turn alive', async () => {
    const empty = sseChunk({ tool_calls: [{}] });
    server.script({ frames: [sseChunk({ content: 'x' }), empty, empty, empty, empty] , keepOpen: true });
    const a = native({ firstTokenTimeoutMs: 2000, idleTimeoutMs: 60 });
    expect(errorOf(await run(a, { tools: [] })).message).toMatch(/stopped responding/);
  });

  it('removes the key in use from a server error', async () => {
    server.script({ status: 400, body: JSON.stringify({ error: { message: 'bad token local-secret here' } }) });
    const error = errorOf(await run(native({}, { apiKey: 'local-secret' }), { tools: [] }));
    expect(error.message).not.toContain('local-secret');
  });

  it('reports a stalled error body by its status, within a short limit', async () => {
    const stalled = (async () => new Response(new ReadableStream({ start() {} }), { status: 503 })) as typeof globalThis.fetch;
    expect(errorOf(await run(native({ fetch: stalled, firstTokenTimeoutMs: 40 }), { tools: [] })).code).toBe('overloaded');
  });

  it('honors Stop while an error body stalls, even on a transport that ignores the signal', async () => {
    const stalled = (async () => new Response(new ReadableStream({ start() {} }), { status: 503 })) as typeof globalThis.fetch;
    const ctl = new AbortController();
    const pending = run(native({ fetch: stalled }), { tools: [] }, ctl.signal);
    await new Promise((r) => setTimeout(r, 20));
    ctl.abort();
    expect(errorOf(await pending).code).toBe('cancelled');
  });

  it('times out a stalled stream on a transport that ignores the signal', async () => {
    const stalled = (async () => new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/event-stream' } })) as typeof globalThis.fetch;
    expect(errorOf(await run(native({ fetch: stalled, firstTokenTimeoutMs: 40 }), { tools: [] })).message).toMatch(/did not start responding/);
  });

  it('completes when a server never closes the stream after the finish reason', async () => {
    server.script({ frames: [sseChunk({ content: 'Done' }), sseChunk({}, 'stop')], keepOpen: true });
    expect(doneOf(await run(native(), { tools: [] })).text).toBe('Done');
  });

  it('keeps leading reasoning out of the chat and the final text', async () => {
    server.script(textReply('<think>Let me plan this carefully.</think>\nHere is the answer.', { size: 3 }));
    const events = await run(native(), { tools: [] });
    expect(textOf(events)).toBe('Here is the answer.');
    expect(doneOf(events).text).toBe('Here is the answer.');
  });

  it('treats an empty reply as an error, not as a finished turn', async () => {
    server.script({ frames: [sseChunk({ role: 'assistant' }), sseChunk({}, 'stop'), DONE] });
    expect(errorOf(await run(native(), { tools: [] }))).toMatchObject({ code: 'unknown', message: expect.stringMatching(/empty/) });
  });
});

describe('native tool calls', () => {
  it('assembles fragmented arguments', async () => {
    server.script(toolCallReply('read_page', { pageId: 'pg_home' }));
    const events = await run(native());
    const done = doneOf(events);
    expect(done.stopReason).toBe('tool_use');
    expect(done.toolCalls).toHaveLength(1);
    expect(done.toolCalls[0]).toMatchObject({ name: 'read_page', arguments: '{"pageId":"pg_home"}' });
    expect(posts()[0].body.tools[0]).toMatchObject({ type: 'function', function: { name: 'read_page' } });
    expect(posts()[0].body.response_format).toBeUndefined();
  });

  it('never reuses a server tool call ID, which the session would treat as a replayed edit', async () => {
    server.script(toolCallReply('read_page', { pageId: 'a' }, { id: 'call_0' }), toolCallReply('read_page', { pageId: 'b' }, { id: 'call_0' }));
    const a = native();
    const first = doneOf(await run(a)).toolCalls[0].id;
    const second = doneOf(await run(a)).toolCalls[0].id;
    expect(first).not.toBe('call_0');
    expect(first).not.toBe(second);
  });

  it('separates parallel calls that share index 0 but have different IDs', async () => {
    server.script({
      frames: [
        sseChunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 'read_page', arguments: '{"pageId":' } }] }),
        sseChunk({ tool_calls: [{ index: 0, function: { arguments: '"one"}' } }] }),
        sseChunk({ tool_calls: [{ index: 0, id: 'b', function: { name: 'read_page', arguments: '{"pageId":"two"}' } }] }),
        sseChunk({}, 'tool_calls'),
        DONE
      ]
    });
    expect(doneOf(await run(native())).toolCalls.map((c) => c.arguments)).toEqual(['{"pageId":"one"}', '{"pageId":"two"}']);
  });

  it('handles fragments without an index, a repeated name and object arguments', async () => {
    server.script({
      frames: [
        sseChunk({ tool_calls: [{ id: 'x', function: { name: 'read_page', arguments: '{"pageId"' } }] }),
        sseChunk({ tool_calls: [{ function: { name: 'read_page', arguments: ':"p"}' } }] }),
        sseChunk({ tool_calls: [{ id: 'y', function: { name: 'set_value', arguments: { value: 1 } } }] }),
        sseChunk({}, 'stop'),
        DONE
      ]
    });
    const done = doneOf(await run(native()));
    expect(done.stopReason).toBe('tool_use');
    expect(done.toolCalls.map((c) => [c.name, c.arguments])).toEqual([
      ['read_page', '{"pageId":"p"}'],
      ['set_value', '{"value":1}']
    ]);
  });

  it('keeps calls apart when a server reuses one ID across indexes', async () => {
    server.script({
      frames: [
        sseChunk({ tool_calls: [{ index: 0, id: 'call_0', function: { name: 'read_page', arguments: '{"pageId":"a"}' } }, { index: 1, id: 'call_0', function: { name: 'read_page', arguments: '{"pageId":"b"}' } }] }),
        sseChunk({}, 'tool_calls'),
        DONE
      ]
    });
    expect(doneOf(await run(native())).toolCalls.map((c) => c.arguments)).toEqual(['{"pageId":"a"}', '{"pageId":"b"}']);
  });

  it('lets an exact ID claim its call before an index-only fragment', async () => {
    server.script({
      frames: [
        sseChunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 'read_page', arguments: '{"pageId":' } }] }),
        sseChunk({ tool_calls: [{ index: 0, id: 'b', function: { name: 'read_page', arguments: '{"pageId":' } }] }),
        sseChunk({ tool_calls: [{ index: 0, function: { arguments: '"one"}' } }, { index: 0, id: 'b', function: { arguments: '"two"}' } }] }),
        sseChunk({}, 'tool_calls'),
        DONE
      ]
    });
    expect(doneOf(await run(native())).toolCalls.map((c) => c.arguments)).toEqual(['{"pageId":"one"}', '{"pageId":"two"}']);
  });

  describe('strict chat templates', () => {
    const NOTE = 'Your last response reached the output limit before it finished, so nothing in it was applied.';
    const calls = [
      { id: 'aaaaaaaa1', name: 'read_page', arguments: '{"pageId":"one"}' },
      { id: 'aaaaaaaa2', name: 'read_page', arguments: '{"pageId":"two"}' }
    ];

    it('renders a note that follows tool results, keeping every call and result in place', async () => {
      // As sent before: the note right after the results breaks the alternation such a template checks.
      const unbridged = [
        { role: 'system', content: 'You edit websites.' },
        { role: 'user', content: 'Read both pages' },
        { role: 'assistant', content: '', tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) },
        { role: 'tool', tool_call_id: 'aaaaaaaa1', content: '{"page":"one"}' },
        { role: 'tool', tool_call_id: 'aaaaaaaa2', content: '{"page":"two"}' },
        { role: 'user', content: NOTE }
      ];
      expect(() => renderStrictTemplate(unbridged)).toThrow(/must alternate/);

      server.script(textReply('Both pages read.'));
      await run(native(), {
        items: [
          { kind: 'user', text: 'Read both pages' },
          { kind: 'assistant', text: '', toolCalls: calls },
          { kind: 'tool_result', callId: 'aaaaaaaa1', name: 'read_page', content: '{"page":"one"}' },
          { kind: 'tool_result', callId: 'aaaaaaaa2', name: 'read_page', content: '{"page":"two"}' },
          { kind: 'user', text: NOTE }
        ]
      });
      const messages = posts()[0].body.messages;
      const rendered = renderStrictTemplate(messages);
      expect(messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool', 'assistant', 'user']);
      expect(messages[2].tool_calls).toEqual(unbridged[2].tool_calls);
      expect(messages[5]).toEqual({ role: 'assistant', content: 'I have read the results.' });
      expect(messages.slice(3, 5)).toEqual([
        { role: 'tool', tool_call_id: 'aaaaaaaa1', name: 'read_page', content: '{"page":"one"}' },
        { role: 'tool', tool_call_id: 'aaaaaaaa2', name: 'read_page', content: '{"page":"two"}' }
      ]);
      expect(messages.at(-1)).toEqual({ role: 'user', content: NOTE });
      expect(rendered.split(NOTE)).toHaveLength(2);
      expect(rendered.indexOf(NOTE)).toBeGreaterThan(rendered.indexOf('{"page":"two"}'));
    });

    it('renders a replayed transcript that opens with a reply or has two replies in a row', async () => {
      server.script(textReply('Done.'), envelopeReply('finish', { message: 'Done.' }));
      const items: CanonicalModelRequest['items'] = [
        { kind: 'assistant', text: 'Added a Pricing page.', toolCalls: [] },
        { kind: 'assistant', text: 'Renamed the site.', toolCalls: [] },
        { kind: 'user', text: 'Now add a Contact page' }
      ];
      await run(native(), { items });
      await run(adapter(), { items });
      expect(posts()).toHaveLength(2);
      const [nativeSent, constrainedSent] = posts().map((p) => p.body.messages as Array<{ role: string; content: string }>);
      for (const messages of [nativeSent, constrainedSent]) {
        expect(() => renderStrictTemplate(messages)).not.toThrow();
        expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user', 'assistant', 'user']);
        expect(messages[1]).toEqual({ role: 'user', content: 'Earlier in this conversation:' });
        expect(messages[3]).toEqual({ role: 'user', content: 'Go on.' });
        expect(messages[5].content).toBe('Now add a Contact page');
      }
      expect([nativeSent[2].content, nativeSent[4].content]).toEqual(['Added a Pricing page.', 'Renamed the site.']);
      // Each earlier answer stays one whole envelope, never two run together.
      expect([JSON.parse(constrainedSent[2].content).action, JSON.parse(constrainedSent[4].content).action]).toEqual([
        { tool: 'finish', args: { message: 'Added a Pricing page.' } },
        { tool: 'finish', args: { message: 'Renamed the site.' } }
      ]);
    });

    it('puts a user turn between two replies that only tool calls separate', async () => {
      server.script(textReply('Done.'));
      await run(native(), {
        items: [
          { kind: 'user', text: 'Read the page' },
          { kind: 'assistant', text: 'Let me look first.', toolCalls: [] },
          { kind: 'assistant', text: '', toolCalls: [calls[0]] },
          { kind: 'tool_result', callId: calls[0].id, name: 'read_page', content: '{"page":"one"}' },
          { kind: 'assistant', text: 'It has one section.', toolCalls: [] },
          { kind: 'user', text: 'Add another' }
        ]
      });
      const messages = posts()[0].body.messages;
      expect(() => renderStrictTemplate(messages)).not.toThrow();
      expect(messages.map((m: { role: string; content: string }) => [m.role, m.content])).toEqual([
        ['system', 'You edit websites.'],
        ['user', 'Read the page'],
        ['assistant', 'Let me look first.'],
        ['assistant', ''],
        ['tool', '{"page":"one"}'],
        ['user', 'Go on.'],
        ['assistant', 'It has one section.'],
        ['user', 'Add another']
      ]);
    });
  });

  it('uses call IDs that strict chat templates accept', async () => {
    server.script(toolCallReply('read_page', { pageId: 'a' }));
    expect(doneOf(await run(native())).toolCalls[0].id).toMatch(/^[a-zA-Z0-9]{9}$/);
  });

  it.each([
    ['a nameless call', [{ index: 0, id: 'a', function: { arguments: '{}' } }]],
    ['a conflicting name', [{ index: 0, id: 'a', function: { name: 'read_page', arguments: '{' } }, null, { index: 0, id: 'a', function: { name: 'set_value', arguments: '}' } }]],
    ['mixed argument encodings', [{ index: 0, id: 'a', function: { name: 'read_page', arguments: '{"x"' } }, null, { index: 0, id: 'a', function: { arguments: { value: 1 } } }]]
  ])('asks again instead of running %s', async (_label, fragments) => {
    const frames = fragments.filter(Boolean).map((f) => sseChunk({ tool_calls: [f] }));
    server.script({ frames: [...frames, sseChunk({}, 'tool_calls'), DONE] }, textReply('Recovered.'));
    expect(doneOf(await run(native()))).toMatchObject({ stopReason: 'end', text: 'Recovered.', toolCalls: [] });
    expect(posts()).toHaveLength(2);
  });

  it('asks again when a turn announces a tool call but sends none', async () => {
    server.script(textReply("I'll continue", { finish: 'tool_calls' }), textReply('Done.'));
    expect(doneOf(await run(native())).text).toBe('Done.');
    expect(posts()).toHaveLength(2);
  });

  it('passes malformed arguments through for the tool loop to reject, but replays them as valid JSON', async () => {
    server.script(toolCallReply('read_page', '{"pageId": "unterminated'), textReply('ok'));
    const a = native();
    const done = doneOf(await run(a));
    expect(done.toolCalls[0].arguments).toBe('{"pageId": "unterminated');
    await run(a, { items: [{ kind: 'user', text: 'Hi' }, { kind: 'assistant', text: '', toolCalls: done.toolCalls }, { kind: 'tool_result', callId: done.toolCalls[0].id, name: 'read_page', content: '{"error":"bad"}', isError: true }] });
    const replayed = posts()[1].body.messages[2];
    expect(replayed.tool_calls[0].function.arguments).toBe('{}');
    expect(posts()[1].body.messages[3]).toMatchObject({ role: 'tool', tool_call_id: done.toolCalls[0].id, name: 'read_page' });
  });

  it('executes nothing from a reply cut off at finish_reason length', async () => {
    server.script(toolCallReply('read_page', '{"pageId":"pg', { finish: 'length' }));
    expect(doneOf(await run(native()))).toMatchObject({ stopReason: 'max_tokens', toolCalls: [] });
  });
});

describe('failures', () => {
  it('explains a refused connection and does not ask for a retry', async () => {
    const port = await closedPort();
    const error = errorOf(await run(adapter({ baseURL: `http://127.0.0.1:${port}/v1` })));
    expect(error.message).toMatch(/Is your local server running\?/);
    expect(error.message).toContain(String(port));
    expect(['rate_limit', 'overloaded', 'network']).not.toContain(error.code);
  });

  it('waits through a long prefill, past the idle limit, once the role chunk has arrived', async () => {
    const slow = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(sseChunk({ role: 'assistant' }))}\n\n`);
      setTimeout(() => res.end(`data: ${JSON.stringify(sseChunk({ content: 'late' }))}\n\ndata: ${JSON.stringify(sseChunk({}, 'stop'))}\n\ndata: [DONE]\n\n`), 150);
    });
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
    const baseURL = `http://127.0.0.1:${(slow.address() as AddressInfo).port}/v1`;
    const events = await run(new LocalAdapter({ baseURL, model: 'm', toolMode: 'native' }, { firstTokenTimeoutMs: 2000, idleTimeoutMs: 40 }), { tools: [] });
    slow.closeAllConnections();
    await new Promise((r) => slow.close(r));
    expect(doneOf(events).text).toBe('late');
  });

  it('times out when the first token never comes, and releases the connection', async () => {
    server.script({ frames: [sseChunk({ role: 'assistant' }), sseChunk({ content: 'x' })], stallAfter: 1 });
    const error = errorOf(await run(native({ firstTokenTimeoutMs: 60, idleTimeoutMs: 5000 }), { tools: [] }));
    expect(error.message).toMatch(/did not start responding/);
    expect(['rate_limit', 'overloaded', 'network']).not.toContain(error.code);
    await expect.poll(() => server.disconnects).toBe(1);
  });

  it('times out when tokens stop mid-reply, using the shorter idle limit', async () => {
    server.script({ frames: [sseChunk({ content: 'partial' }), sseChunk({ content: ' more' })], stallAfter: 1 });
    const started = Date.now();
    const events = await run(native({ firstTokenTimeoutMs: 5000, idleTimeoutMs: 60 }), { tools: [] });
    expect(errorOf(events).message).toMatch(/stopped responding/);
    expect(Date.now() - started).toBeLessThan(2000);
    await expect.poll(() => server.disconnects).toBe(1);
  });

  it.each([
    ['during prefill', 0],
    ['mid-stream', 1]
  ])('honors the abort signal %s and stops the server', async (_label, stallAfter) => {
    server.script({ frames: [sseChunk({ content: 'partial' }), sseChunk({ content: ' more' })], stallAfter });
    const ctl = new AbortController();
    const pending = run(native(), { tools: [] }, ctl.signal);
    await expect.poll(() => posts().length).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    ctl.abort();
    expect(errorOf(await pending)).toMatchObject({ code: 'cancelled' });
    await expect.poll(() => server.disconnects).toBe(1);
  });

  it('ends generation on the server when the consumer stops reading', async () => {
    server.script({ frames: [sseChunk({ content: 'first' }), sseChunk({ content: ' second' })], stallAfter: 1 });
    for await (const ev of native().streamTurn(request({ tools: [] }), new AbortController().signal)) if (ev.type === 'text') break;
    await expect.poll(() => server.disconnects).toBe(1);
  });

  it('reports a connection lost mid-reply as retryable', async () => {
    server.script({ frames: [sseChunk({ content: 'partial' }), sseChunk({ content: ' more' })], dropAfter: 1 });
    expect(errorOf(await run(native(), { tools: [] })).code).toBe('network');
  });

  it('reports a stream that ends without a finish reason as retryable', async () => {
    server.script({ frames: [sseChunk({ content: 'partial' })] });
    expect(errorOf(await run(native(), { tools: [] })).code).toBe('network');
  });

  it('classifies HTTP errors', async () => {
    server.script(
      { status: 503, body: JSON.stringify({ error: { message: 'Loading model', type: 'unavailable_error', code: 503 } }) },
      { status: 400, body: JSON.stringify({ error: { message: 'the request exceeds the available context size' } }) },
      { status: 401, body: 'nope' },
      { status: 404, body: JSON.stringify({ error: 'model "ghost" not found' }) }
    );
    const a = native();
    expect(errorOf(await run(a, { tools: [] }))).toMatchObject({ code: 'overloaded', message: expect.stringMatching(/still loading/) });
    expect(errorOf(await run(a, { tools: [] }))).toMatchObject({ code: 'invalid_request', message: expect.stringMatching(/context window/) });
    expect(errorOf(await run(a, { tools: [] }))).toMatchObject({ code: 'auth' });
    expect(errorOf(await run(a, { tools: [] }))).toMatchObject({ code: 'invalid_request', message: expect.stringMatching(/ghost/) });
  });

  it('reports an error sent inside the stream', async () => {
    server.script({ frames: [sseChunk({ content: 'x' }), 'error: {"message":"slot crashed","code":500}\n\n'] });
    expect(errorOf(await run(native(), { tools: [] })).message).toMatch(/slot crashed/);
  });

  it('does not print an empty error body', async () => {
    server.script({ status: 500, body: '{}' });
    expect(errorOf(await run(native(), { tools: [] })).message).toBe('The local server reported an error.');
    server.script({ frames: ['error: {}\n\n'] });
    expect(errorOf(await run(native(), { tools: [] })).message).toBe('The local server reported an error.');
  });

  it('drops stream_options when the server refuses it', async () => {
    server.script({ status: 400, body: JSON.stringify({ error: { message: 'unknown field stream_options' } }) }, textReply('ok'));
    expect(doneOf(await run(native(), { tools: [] })).text).toBe('ok');
    expect(posts()[0].body.stream_options).toBeDefined();
    expect(posts()[1].body.stream_options).toBeUndefined();
  });

  it('never follows a redirect, which could carry project content off this computer', async () => {
    let reached = 0;
    const elsewhere = createServer((_req, res) => {
      reached++;
      res.end();
    });
    await new Promise<void>((r) => elsewhere.listen(0, '127.0.0.1', r));
    const target = `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}/steal`;
    server.script({ status: 307, headers: { location: target } });
    const error = errorOf(await run(native(), { tools: [] }));
    await new Promise((r) => elsewhere.close(r));
    expect(error.message).toMatch(/redirect/);
    // A server set up to redirect is the setup's to fix.
    expect(error.setup).toBe('server');
    expect(reached).toBe(0);
  });
});

describe('where a request may go', () => {
  it.each(['http://127.0.0.1:8080/v1', 'http://localhost:1234/v1', 'http://[::1]:8080/v1', 'http://127.1.2.3/v1', 'http://2130706433:8080/v1', 'http://[::ffff:127.0.0.1]:8080/v1'])('allows loopback %s', (url) => {
    expect(checkLocalBaseURL(url)).toMatchObject({ ok: true, remote: false });
  });

  it.each(['http://192.168.1.20:8080/v1', 'http://example.com/v1', 'http://127.0.0.1.nip.io/v1', 'http://localhost.example.com/v1', 'http://[::ffff:8.8.8.8]/v1', 'http://0.0.0.0:8080/v1'])('refuses %s by default, and allows it only when asked', (url) => {
    expect(checkLocalBaseURL(url)).toMatchObject({ ok: false, message: expect.stringMatching(/not on this computer/) });
    expect(checkLocalBaseURL(url, true)).toMatchObject({ ok: true, remote: true });
  });

  it.each(['not a url', 'ftp://127.0.0.1/v1', 'file:///etc/passwd', 'http://user:pass@127.0.0.1/v1', 'http://127.0.0.1/v1?x=1', 'http://127.0.0.1/v1#a'])('rejects %s', (url) => {
    expect(checkLocalBaseURL(url, true).ok).toBe(false);
  });

  describe('localhost', () => {
    const port = () => new URL(server.baseURL).port;
    const endpoint = () => ({ baseURL: `http://localhost:${port()}/v1`, model: 'test-model', apiKey: 'local-secret', toolMode: 'native' as const });
    /** A fetch that counts its calls and stands in for the server, since `localhost` itself is never resolved here. */
    function counting() {
      const targets: string[] = [];
      const fetch = ((input: string | URL | Request, init?: RequestInit) => {
        targets.push(String(input));
        return globalThis.fetch(String(input).replace('//localhost:', '//127.0.0.1:'), init);
      }) as typeof globalThis.fetch;
      return { fetch, targets };
    }

    it('keeps the name in the address, so proxy exclusions and certificates for it still apply', () => {
      expect(checkLocalBaseURL(`http://LOCALHOST:${port()}/v1/`)).toEqual({ ok: true, url: `http://localhost:${port()}/v1`, remote: false });
    });

    it('sends to localhost once every address it resolves to is this computer', async () => {
      const { fetch, targets } = counting();
      const lookup = async () => [{ address: '127.0.0.1' }, { address: '::1' }, { address: '::ffff:127.0.0.1' }];
      server.script(textReply('ok'));
      expect((await listLocalModels(endpoint(), { fetch, lookup })).ok).toBe(true);
      expect(doneOf(await run(new LocalAdapter(endpoint(), { fetch, lookup }), { tools: [] })).text).toBe('ok');
      expect(targets).toEqual([`http://localhost:${port()}/v1/models`, `http://localhost:${port()}/v1/chat/completions`]);
    });

    it('neither waits on a stalled lookup nor outlasts Stop', async () => {
      const { fetch, targets } = counting();
      const stalled = () => new Promise<Array<{ address: string }>>(() => undefined);
      const started = Date.now();
      expect(await listLocalModels(endpoint(), { fetch, lookup: stalled })).toMatchObject({ ok: false, message: expect.stringMatching(/could not be looked up/) });
      expect(Date.now() - started).toBeLessThan(4000);
      const stop = new AbortController();
      const turn = run(new LocalAdapter(endpoint(), { fetch, lookup: stalled }), { tools: [] }, stop.signal);
      stop.abort();
      expect(errorOf(await turn)).toMatchObject({ code: 'cancelled' });
      expect(targets).toEqual([]);
    });

    it.each([
      ['points somewhere else', async () => [{ address: '127.0.0.1' }, { address: '203.0.113.7' }], /points to 203\.0\.113\.7/],
      ['cannot be looked up', async (): Promise<Array<{ address: string }>> => Promise.reject(new Error('ENOTFOUND')), /could not be looked up/]
    ])('sends nothing when localhost %s', async (_label, lookup, message) => {
      const { fetch, targets } = counting();
      expect(errorOf(await run(new LocalAdapter(endpoint(), { fetch, lookup }), { tools: [] }))).toMatchObject({ code: 'invalid_request', message: expect.stringMatching(message) });
      expect(await listLocalModels(endpoint(), { fetch, lookup })).toMatchObject({ ok: false, message: expect.stringMatching(message) });
      expect(await testLocal(endpoint(), { fetch, lookup })).toMatchObject({ ok: false, message: expect.stringMatching(message) });
      expect(targets).toEqual([]);
      expect(server.requests).toEqual([]);
    });
  });

  /** Fake keys at the length real ones have. */
  const fake = (prefix: string) => `${prefix}${'Ab3_dE6-gH9'.repeat(5)}`;

  it.each([
    [fake('sk-proj-'), 'OpenAI'],
    [fake('sk-svcacct-'), 'OpenAI'],
    [fake('sk-admin-'), 'OpenAI'],
    [fake('sk-None-'), 'OpenAI'],
    [`sk-${'a1B2c3D4e5'.repeat(2)}T3BlbkFJ${'f6G7h8I9j0'.repeat(2)}`, 'OpenAI'],
    [`Bearer ${fake('sk-proj-')}`, 'OpenAI'],
    [`OPENAI_API_KEY=${fake('sk-proj-')}`, 'OpenAI'],
    [`(${fake('sk-proj-')})`, 'OpenAI'],
    [`  "${fake('sk-ant-api03-')}"  `, 'Anthropic'],
    // The shortest each prefix counts at.
    [`sk-ant-${'a'.repeat(33)}`, 'Anthropic'],
    [`sk-proj-${'a'.repeat(30)}`, 'OpenAI']
  ])('recognizes the cloud key %s', (key, provider) => {
    expect(localKeyProblem(key)).toContain(`an ${provider} API key`);
  });

  it.each(['', '   ', 'local-secret', 'ollama', 'lm-studio', 'sk-no-key-required', 'sk-local-dev', 'sk-proj-local', 'lab:sk-proj-local', 'sk-ant-mine', `sk-ant-${'a'.repeat(32)}`, `sk-proj-${'a'.repeat(29)}`, 'sk-1234567890abcdefghijkl', `sk-${'0123456789abcdef'.repeat(2)}`, `sk-${'x9'.repeat(30)}`])(
    'accepts the local key "%s"',
    (key) => {
      expect(localKeyProblem(key)).toBeNull();
    }
  );

  it.each([
    ['on this computer', () => server.baseURL, fake('sk-ant-api03-'), 'Anthropic'],
    ['on another machine', () => 'http://192.0.2.10:8080/v1', fake('sk-proj-'), 'OpenAI']
  ])('never sends a cloud key to a local server %s', async (_where, baseURL, apiKey, provider) => {
    let calls = 0;
    const fetch = ((input: string | URL | Request, init?: RequestInit) => {
      calls++;
      return globalThis.fetch(input, init);
    }) as typeof globalThis.fetch;
    const endpoint = { baseURL: baseURL(), model: 'test-model', apiKey, allowRemote: true };
    const refused = expect.stringContaining(`an ${provider} API key`);
    expect(errorOf(await run(new LocalAdapter(endpoint, { fetch }), { tools: [] }))).toMatchObject({ code: 'invalid_request', message: refused });
    expect(await listLocalModels(endpoint, { fetch })).toMatchObject({ ok: false, message: refused });
    expect(await testLocal(endpoint, { fetch })).toMatchObject({ ok: false, message: refused });
    expect(calls).toBe(0);
    expect(server.requests).toEqual([]);
  });

  it('counts only a real true as permission', () => {
    expect(checkLocalBaseURL('http://example.com/v1', 'false' as unknown as boolean).ok).toBe(false);
  });

  it('sends nothing when the saved permission is not a real true', async () => {
    let calls = 0;
    const fetch = (async () => {
      calls++;
      return new Response('');
    }) as typeof globalThis.fetch;
    const events = await run(new LocalAdapter({ baseURL: 'http://example.com/v1', model: 'm', allowRemote: 'false' as unknown as boolean }, { fetch }));
    expect(errorOf(events).message).toMatch(/not on this computer/);
    expect(calls).toBe(0);
  });

  it('does not follow a redirect during discovery', async () => {
    let reached = 0;
    const elsewhere = createServer((_req, res) => {
      reached++;
      res.end('{"data":[]}');
    });
    await new Promise<void>((r) => elsewhere.listen(0, '127.0.0.1', r));
    const target = `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}/v1/models`;
    const redirecting = createServer((_req, res) => {
      res.writeHead(307, { location: target });
      res.end();
    });
    await new Promise<void>((r) => redirecting.listen(0, '127.0.0.1', r));
    const baseURL = `http://127.0.0.1:${(redirecting.address() as AddressInfo).port}/v1`;
    const found = await listLocalModels({ baseURL });
    const tested = await testLocal({ baseURL, model: 'm' });
    await new Promise((r) => redirecting.close(r));
    await new Promise((r) => elsewhere.close(r));
    expect(found.ok).toBe(false);
    expect(tested.ok).toBe(false);
    expect(reached).toBe(0);
  });

  it('normalizes the path', () => {
    expect(checkLocalBaseURL('http://127.0.0.1:8080')).toMatchObject({ url: 'http://127.0.0.1:8080/v1' });
    expect(checkLocalBaseURL(' http://127.0.0.1:8080/v1/ ')).toMatchObject({ url: 'http://127.0.0.1:8080/v1' });
  });

  it('every preset is loopback, and llama.cpp comes first', () => {
    expect(LOCAL_PRESETS[0].id).toBe('llama.cpp');
    for (const p of LOCAL_PRESETS) expect(checkLocalBaseURL(p.baseURL)).toMatchObject({ ok: true, remote: false, url: p.baseURL });
  });

  it('sends nothing to a remote server unless it is allowed', async () => {
    let calls = 0;
    const fetch = (async () => {
      calls++;
      return new Response('');
    }) as typeof globalThis.fetch;
    const events = await run(new LocalAdapter({ baseURL: 'http://example.com/v1', model: 'm' }, { fetch }));
    expect(errorOf(events)).toMatchObject({ code: 'invalid_request', message: expect.stringMatching(/not on this computer/) });
    expect(await listLocalModels({ baseURL: 'http://example.com/v1' }, { fetch })).toMatchObject({ ok: false });
    expect(calls).toBe(0);
  });
});

describe('model discovery', () => {
  it('lists models', async () => {
    server.models = { data: [{ id: 'b-model' }, { id: 'a-model' }, { id: 'b-model' }, { nope: true }] };
    expect(await listLocalModels({ baseURL: server.baseURL })).toEqual({ ok: true, models: ['b-model', 'a-model'] });
    expect(server.requests[0]).toMatchObject({ method: 'GET', url: '/v1/models' });
  });

  it('explains a server that is not running', async () => {
    const port = await closedPort();
    expect(await listLocalModels({ baseURL: `http://127.0.0.1:${port}/v1` })).toMatchObject({ ok: false, models: [], message: expect.stringMatching(/Is your local server running/) });
  });

  it('tests a connection with one short chat request to the chosen model, or the first listed', async () => {
    server.models = { data: [{ id: 'first-model' }, { id: 'test-model' }] };
    server.script(textReply('OK'), textReply('OK'));
    expect(await testLocal({ baseURL: server.baseURL, model: 'test-model' })).toEqual({ ok: true, model: 'test-model', message: 'Connected. test-model answered a test chat request.' });
    expect(await testLocal({ baseURL: server.baseURL, model: '' })).toEqual({ ok: true, model: 'first-model', message: 'Connected. first-model answered a test chat request.' });
    expect(posts().map((p) => [p.url, p.body.model])).toEqual([
      ['/v1/chat/completions', 'test-model'],
      ['/v1/chat/completions', 'first-model']
    ]);
    // Plain chat, as small as a reply can be: no tools and no grammar, so any chat model can answer it.
    expect(posts()[0].body).toMatchObject({ max_tokens: 16, messages: [{ role: 'system' }, { role: 'user', content: 'Reply with OK.' }] });
    expect(posts()[0].body.tools).toBeUndefined();
    expect(posts()[0].body.response_format).toBeUndefined();
  });

  it('sends no chat request when nothing answers, the model is not listed, or none is loaded', async () => {
    const port = await closedPort();
    expect(await testLocal({ baseURL: `http://127.0.0.1:${port}/v1`, model: '' })).toMatchObject({ ok: false, stage: 'server', message: expect.stringMatching(/Is your local server running/) });
    expect(await testLocal({ baseURL: server.baseURL, model: 'ghost' })).toMatchObject({ ok: false, stage: 'server', message: expect.stringContaining('ghost') });
    server.models = { data: [] };
    expect(await testLocal({ baseURL: server.baseURL, model: '' })).toMatchObject({ ok: false, stage: 'server', message: expect.stringMatching(/no models/) });
    expect(posts()).toHaveLength(0);
  });

  it('fails a model the server lists but that rejects a chat request', async () => {
    server.models = { data: [{ id: 'studio-b' }] };
    server.script({ status: 400, body: JSON.stringify({ error: { message: 'studio-b cannot generate chat completions' } }) });
    const r = await testLocal({ baseURL: server.baseURL, model: 'studio-b' });
    expect(r).toEqual({ ok: false, stage: 'chat', model: 'studio-b', message: 'The server lists studio-b, but a test chat request failed: studio-b cannot generate chat completions' });
    expect(posts()).toHaveLength(1);
  });

  it('passes a reply cut off at the small budget, which a reasoning model spends thinking, and says so', async () => {
    // No usage chunk: not every server reports one, and the reply still came from the model.
    server.script({ frames: [sseChunk({ role: 'assistant' }), sseChunk({ reasoning_content: 'The user wants' }), sseChunk({}, 'length'), DONE] });
    expect(await testLocal({ baseURL: server.baseURL, model: 'test-model' })).toEqual({ ok: true, model: 'test-model', message: 'Connected. test-model started answering a test chat request.' });
  });

  it('names the size a run will use, which a smaller size set in Settings holds it to', async () => {
    server.script(textReply('OK'));
    server.routes['/props'] = { body: { default_generation_settings: { n_ctx: 32768 } } };
    expect((await testLocal({ baseURL: server.baseURL, model: 'test-model', contextWindow: 4096 })).message).toMatch(/held to the 4,096-token context set in Settings\. The assistant works best with 32,768 tokens/);
  });

  it('fails a model that declines the test request', async () => {
    server.script(textReply('', { finish: 'content_filter' }));
    expect(await testLocal({ baseURL: server.baseURL, model: 'test-model' })).toMatchObject({ ok: false, stage: 'chat', message: expect.stringMatching(/declined it/) });
  });

  it('ends within its deadline however slowly the reply trickles in', async () => {
    server.script({ frames: [sseChunk({ role: 'assistant' })], endless: { frame: sseChunk({ content: '.' }), everyMs: 20 } });
    const started = Date.now();
    const r = await testLocal({ baseURL: server.baseURL, model: 'test-model' }, { deadlineMs: 300 });
    expect(r).toMatchObject({ ok: false, stage: 'chat', message: expect.stringMatching(/did not finish a short reply/) });
    expect(Date.now() - started).toBeLessThan(3000);
    await expect.poll(() => server.disconnects).toBe(1);
  });

  it('stops when asked: before anything is sent, or in the middle of the chat request', async () => {
    const stopped = new AbortController();
    stopped.abort();
    expect(await testLocal({ baseURL: server.baseURL, model: 'test-model' }, { signal: stopped.signal })).toMatchObject({ ok: false, message: 'The test was stopped.' });
    expect(server.requests).toHaveLength(0);

    server.script({ ...textReply('OK'), delayMs: 5000 });
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 100);
    const started = Date.now();
    expect(await testLocal({ baseURL: server.baseURL, model: 'test-model' }, { signal: stop.signal })).toMatchObject({ ok: false, message: 'The test was stopped.' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('gives up on a model that never starts answering, and lets the connection go', async () => {
    server.script({ frames: [sseChunk({ role: 'assistant' })], stallAfter: 0 });
    const r = await testLocal({ baseURL: server.baseURL, model: 'test-model' }, { firstTokenTimeoutMs: 150 });
    expect(r).toMatchObject({ ok: false, stage: 'chat', message: expect.stringMatching(/did not start responding/) });
    await expect.poll(() => server.disconnects).toBe(1);
  });
});

describe('what a chat request shows about the setup', () => {
  const reported = (endpoint: Partial<LocalEndpoint> = {}) => {
    const checks: unknown[] = [];
    return { checks, a: adapter(endpoint, { onCheck: (c) => checks.push(c) }) };
  };

  it('reports a finished reply as working', async () => {
    server.script(textReply('Hi'));
    const { checks, a } = reported();
    await run(a, { tools: [] });
    expect(checks).toEqual([{ ok: true }]);
  });

  it('reports a server that is not there and a refused chat request, each with where it failed, and marks them as the setup', async () => {
    const port = await closedPort();
    const down = reported({ baseURL: `http://127.0.0.1:${port}/v1` });
    expect(errorOf(await run(down.a))).toMatchObject({ code: 'unreachable', setup: 'server' });
    expect(down.checks).toEqual([{ ok: false, stage: 'server', message: expect.stringMatching(/Is your local server running/) }]);

    // A key the chat request needs is a chat failure: the model list may not need one, so listing cannot clear it.
    // A refusal it cannot place gets the full schema once (#364), and is reported once that is refused too.
    const cannotChat = { status: 400, body: JSON.stringify({ error: { message: 'model cannot chat' } }) };
    server.script({ status: 401, body: '{}' }, cannotChat, cannotChat);
    const refused = reported();
    expect(errorOf(await run(refused.a))).toMatchObject({ code: 'auth', setup: 'chat' });
    expect(errorOf(await run(refused.a))).toMatchObject({ code: 'invalid_request', setup: 'chat' });
    expect(refused.checks).toEqual([
      { ok: false, stage: 'chat', message: expect.stringMatching(/rejected the API key/) },
      { ok: false, stage: 'chat', message: 'model cannot chat' }
    ]);
  });

  it('treats a refusal sent inside the stream like the same refusal as a status, by number or by name', async () => {
    server.script({ frames: [sseChunk({ role: 'assistant' }), { error: { code: 404, message: 'model not found' } }, DONE] }, { frames: [sseChunk({ role: 'assistant' }), { error: { code: 'model_not_found', message: 'no such model' } }, DONE] }, { frames: [sseChunk({ role: 'assistant' }), { error: { type: 'invalid_request_error', message: 'Input prompt too large' } }, DONE] });
    const { checks, a } = reported();
    expect(errorOf(await run(a))).toMatchObject({ setup: 'chat', message: expect.stringMatching(/model not found/) });
    expect(errorOf(await run(a))).toMatchObject({ setup: 'chat', message: expect.stringMatching(/no such model/) });
    expect(errorOf(await run(a)).setup).toBeUndefined();
    expect(checks).toEqual([
      { ok: false, stage: 'chat', message: expect.stringMatching(/model not found/) },
      { ok: false, stage: 'chat', message: expect.stringMatching(/no such model/) }
    ]);
  });

  it('says nothing about a request too large for the server, which is the request\'s own', async () => {
    server.script({ status: 413, body: JSON.stringify({ error: { message: 'Payload too large' } }) });
    const { checks, a } = reported();
    expect(errorOf(await run(a)).setup).toBeUndefined();
    expect(checks).toEqual([]);
  });

  it("says nothing about a busy or loading server, or a conversation too long for the model: they are not the setup's", async () => {
    server.script({ status: 429, body: '{}' }, { status: 503, body: JSON.stringify({ error: { message: 'Loading model' } }) }, { status: 400, body: JSON.stringify({ error: { message: 'the request exceeds the available context size' } }) });
    const { checks, a } = reported();
    const errors = [errorOf(await run(a)), errorOf(await run(a)), errorOf(await run(a))];
    expect(errors.map((e) => e.setup)).toEqual([undefined, undefined, undefined]);
    expect(errors[2].message).toMatch(/too long for this model/);
    expect(checks).toEqual([]);
  });
});

describe('capability profiles', () => {
  const custom = { toolCalling: 'native' as const, contextWindow: 8192, maxOutput: 1024, temperature: 0 };

  it('defaults every unknown model to constrained JSON', () => {
    expect(localModelProfile('some-model-q4.gguf')).toEqual(DEFAULT_LOCAL_PROFILE);
    expect(DEFAULT_LOCAL_PROFILE.toolCalling).toBe('constrained-json');
    expect(adapter().capabilities()).toMatchObject({ toolCalling: 'constrained-json', strictSchemas: true, contextWindowTokens: DEFAULT_LOCAL_PROFILE.contextWindow });
    expect(modelInfo('local', 'anything')).toMatchObject({ contextWindow: DEFAULT_LOCAL_PROFILE.contextWindow, maxOutput: DEFAULT_LOCAL_PROFILE.maxOutput });
  });

  it.each([
    'qwen3.5-2b',
    'qwen-3.5-2b',
    'qwen_3.5_2b',
    'Qwen3.5-2B-Instruct',
    'Qwen/Qwen3.5-2B',
    'Qwen3.5-2B-Q4_K_M.gguf',
    'Qwen_Qwen3.5-2B-Instruct-IQ4_XS.gguf',
    'qwen3.5-2b.Q8_0.gguf',
    '/Users/me/models/Qwen3.5-2B-Instruct-f16.gguf',
    'C:\\models\\Qwen3.5-2B-Q5_K_S.gguf',
    'qwen3.5:2b',
    'qwen3.5:2b-q4_K_M',
    'hf.co/unsloth/Qwen3.5-2B-GGUF:Q4_K_M'
  ])('gives Qwen3.5-2B its own context and reply budget, as %s', (id) => {
    expect(localModelProfile(id)).toMatchObject({ toolCalling: 'constrained-json', contextWindow: 131_072, maxOutput: 16_384, temperature: DEFAULT_LOCAL_PROFILE.temperature });
    expect(adapter({ model: id }).capabilities()).toMatchObject({ contextWindowTokens: 131_072, maxOutputTokens: 16_384, contextWindowKnown: false });
    expect(modelInfo('local', id)).toMatchObject({ contextWindow: 131_072, maxOutput: 16_384 });
  });

  it.each([
    'qwen3.5-27b',
    'qwen3.5:27b',
    'qwen3.5-0.2b',
    'qwen3.5-2.5b',
    'qwen3-2b',
    'qwen2.5-2b',
    'qwen3.5-122b',
    'qwen3.5-2billion',
    'qwen3.5-2b2',
    'notqwen3.5-2b',
    '/models/Qwen3.5-2B-GGUF/Qwen3.5-27B-Q4_K_M.gguf',
    'C:\\qwen3.5-2b\\other-model.gguf'
  ])('does not take %s for Qwen3.5-2B', (id) => {
    expect(localModelProfile(id)).toEqual(DEFAULT_LOCAL_PROFILE);
    expect(adapter({ model: id }).capabilities()).toMatchObject({ contextWindowTokens: 32_768, maxOutputTokens: 8192 });
  });

  it('holds Qwen3.5-2B to the smaller of Settings and the server, and to its profile only with neither', () => {
    const window = (endpoint: Partial<LocalEndpoint>, windowTokens?: number) => adapter({ model: 'qwen3.5:2b', ...endpoint }, { context: windowTokens ? { windowTokens } : {} }).capabilities();
    expect(window({}, 8192)).toMatchObject({ contextWindowTokens: 8192, contextWindowKnown: true, maxOutputTokens: 16_384 });
    // A server that loaded more than the profile assumes is believed.
    expect(window({}, 262_144).contextWindowTokens).toBe(262_144);
    expect(window({ contextWindow: 200_000 })).toMatchObject({ contextWindowTokens: 200_000, contextWindowKnown: true });
    expect(window({ contextWindow: 16_384 }, 65_536).contextWindowTokens).toBe(16_384);
    expect(window({ contextWindow: 65_536 }, 4096).contextWindowTokens).toBe(4096);
  });

  it("names Qwen3.5-2B's own capacity in the steps for a server that loaded it with less than its profile", () => {
    const help = (model: string, windowTokens?: number) => adapter({ model }, { context: { server: 'ollama', ...(windowTokens ? { windowTokens } : {}) } }).contextHelp(32_768);
    const small = help('qwen3.5:2b', 8192);
    expect(small).toMatch(/^Qwen3\.5-2B itself takes up to 262,144 tokens\. /);
    expect(small).toContain('OLLAMA_CONTEXT_LENGTH=32768');
    // Nothing reported, or enough loaded already: no claim about what was loaded.
    expect(help('qwen3.5:2b')).not.toContain('262,144');
    expect(help('qwen3.5:2b', 131_072)).not.toContain('262,144');
    expect(adapter({ model: 'qwen3.5:2b' }, { context: { windowTokens: 131_072 } }).contextHelp(262_144)).not.toContain('itself takes');
    // A model with no profile of its own has no known capacity to name.
    expect(help('other:7b', 8192)).not.toContain('itself takes');
  });

  it('a model is added as one entry, and the first match wins', () => {
    const profiles = [{ match: /^our-model/, profile: { contextWindow: 16384 } }, { match: /our/, profile: { contextWindow: 1 } }];
    expect(localModelProfile('our-model-4b', profiles)).toEqual({ ...DEFAULT_LOCAL_PROFILE, contextWindow: 16384 });
    expect(localModelProfile('other', profiles)).toEqual(DEFAULT_LOCAL_PROFILE);
  });

  it('auto follows the profile and an explicit mode overrides it', () => {
    expect(adapter({ toolMode: 'auto' }, { profile: custom }).capabilities().toolCalling).toBe('native');
    expect(adapter({ toolMode: 'constrained-json' }, { profile: custom }).capabilities().toolCalling).toBe('constrained-json');
    expect(adapter({ toolMode: 'native' }).capabilities().toolCalling).toBe('native');
  });

  it('applies the profile output cap and temperature to the request', async () => {
    server.script(textReply('ok'));
    await run(adapter({}, { profile: custom }), { tools: [], maxOutputTokens: 9000 });
    expect(posts()[0].body).toMatchObject({ max_tokens: 1024, temperature: 0 });
  });
});

describe('constrained JSON', () => {
  it('sends a strict envelope and no native tools', async () => {
    server.script(envelopeReply('read_page', { pageId: 'pg_home' }));
    await run(adapter());
    const body = posts()[0].body;
    expect(body.tools).toBeUndefined();
    expect(body.response_format).toMatchObject({ type: 'json_schema', json_schema: { strict: true } });
    expect(findForbiddenShapes(body.response_format.json_schema.schema)).toEqual([]);
    // The compact form goes first: the same grammar, without the type beside each enum of strings.
    expect(body.response_format.json_schema.schema).toEqual(envelopeSchema(TOOLS, { compact: true }));
    expect(body.messages[0].content).toContain('read_page {pageId!}');
    expect(body.messages[0].content).toContain('Read a page');
    expect(body.messages[0].content).toContain('"finish"');
  });

  it('builds a compilable envelope for the real tool set', () => {
    for (const opts of [{ codeEnabled: true, definitionOps: true }, { codeEnabled: false, definitionOps: false }]) {
      const tools = toolDefinitions(opts);
      const schema = envelopeSchema(tools);
      expect(findForbiddenShapes(schema)).toEqual([]);
      const branches = (schema.properties as { action: { anyOf: Array<{ properties: { tool: { enum: string[] } } }> } }).action.anyOf;
      expect(branches.map((b) => b.properties.tool.enum[0])).toEqual([...tools.map((t) => t.name), 'finish']);
    }
  });

  it('maps the envelope onto one ordinary tool call and shows the status live', async () => {
    server.script(envelopeReply('read_page', { pageId: 'pg_home' }, 'Reading the home page'));
    const events = await run(adapter());
    expect(textOf(events)).toBe('Reading the home page');
    const done = doneOf(events);
    expect(done.stopReason).toBe('tool_use');
    expect(done.text).toBe('Reading the home page');
    expect(done.toolCalls).toHaveLength(1);
    expect(done.toolCalls[0]).toMatchObject({ name: 'read_page', arguments: '{"pageId":"pg_home"}' });
  });

  it('decodes an open value before the tool sees it', async () => {
    const link = { type: 'page', target: 'pg_home' };
    server.script(envelopeReply('set_value', { value: { $json: JSON.stringify(link) } }));
    expect(JSON.parse(doneOf(await run(adapter())).toolCalls[0].arguments)).toEqual({ value: link });
  });

  it('turns the finish action into a final answer with no tool call', async () => {
    server.script(envelopeReply('finish', { message: 'Updated the headline.' }, 'Finishing'));
    expect(doneOf(await run(adapter()))).toMatchObject({ stopReason: 'end', text: 'Updated the headline.', toolCalls: [] });
  });

  it('replays the exact envelope and sends tool results as user messages', async () => {
    server.script(envelopeReply('set_value', { value: { $json: '[1]' } }), envelopeReply('finish', { message: 'Done.' }));
    const a = adapter();
    const done = doneOf(await run(a));
    await run(a, {
      items: [
        { kind: 'user', text: 'Hi' },
        { kind: 'assistant', text: done.text, toolCalls: done.toolCalls, providerData: done.providerData },
        { kind: 'tool_result', callId: done.toolCalls[0].id, name: 'set_value', content: '{"ok":true}' },
        { kind: 'user', text: 'Validation found new errors.' }
      ]
    });
    const messages = posts()[1].body.messages;
    expect(messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(() => renderStrictTemplate(messages)).not.toThrow();
    expect(JSON.parse(messages[2].content).action.args).toEqual({ value: { $json: '[1]' } });
    expect(messages[3].content).toContain('Result of set_value:\n{"ok":true}');
    expect(messages[3].content).toContain('Validation found new errors.');
    expect(messages[3].content.indexOf('Result of set_value')).toBeLessThan(messages[3].content.indexOf('Validation found new errors.'));
    expect(JSON.parse(messages[2].content)).toEqual({ brief_status: done.text, action: { tool: 'set_value', args: { value: { $json: '[1]' } } } });
  });

  it('replays an earlier request’s answer as a finish envelope, never as prose (#195)', async () => {
    // The server refuses the compact schema, the full one, then the JSON mode: every request still shows the history
    // in the format.
    server.script(
      { status: 400, body: JSON.stringify({ error: { message: 'Failed to parse grammar' } }) },
      { status: 400, body: JSON.stringify({ error: { message: 'Failed to parse grammar' } }) },
      { status: 400, body: JSON.stringify({ error: { message: 'response_format type not supported' } }) },
      envelopeReply('finish', { message: 'Done.' }),
      textReply('ok')
    );
    const items: CanonicalModelRequest['items'] = [
      { kind: 'user', text: 'Make the headline bolder' },
      // A finished turn read back from the transcript carries no provider data.
      { kind: 'assistant', text: 'Made the headline bolder.', toolCalls: [] },
      { kind: 'user', text: 'Which button?' },
      // A blank turn has no message a finish could carry, so it is left out.
      { kind: 'assistant', text: '  ', toolCalls: [] },
      { kind: 'user', text: 'Now the button' }
    ];
    await run(adapter(), { items });
    expect(posts().map((r) => r.body.response_format?.type)).toEqual(['json_schema', 'json_schema', 'json_object', undefined]);
    expect(posts()[0].body.response_format.json_schema.schema).toEqual(envelopeSchema(TOOLS, { compact: true }));
    expect(posts()[1].body.response_format.json_schema.schema).toEqual(envelopeSchema(TOOLS));
    for (const post of posts()) {
      const messages = post.body.messages as Array<{ role: string; content: string }>;
      expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
      expect(parseEnvelope(messages[2].content)).toMatchObject({ ok: true, finish: 'Made the headline bolder.' });
      expect(messages[3].content).toBe('Which button?\n\nNow the button');
    }
    // Native tool calling keeps the plain text.
    await run(native(), { items: items.slice(0, 3) });
    expect(posts()[4].body.messages[2]).toEqual({ role: 'assistant', content: 'Made the headline bolder.' });
  });

  it('labels a failed tool result as an error', async () => {
    server.script(envelopeReply('finish', { message: 'Done.' }));
    await run(adapter(), { items: [{ kind: 'assistant', text: 's', toolCalls: [{ id: 'c', name: 'read_page', arguments: '{}' }] }, { kind: 'tool_result', callId: 'c', name: 'read_page', content: 'nope', isError: true }] });
    expect(posts()[0].body.messages.at(-1).content).toContain('Error from read_page:');
  });

  it('asks again after an unusable reply, then carries on', async () => {
    server.script(textReply('Sure, I can help with that!'), envelopeReply('read_page', { pageId: 'p' }));
    const done = doneOf(await run(adapter()));
    expect(done.toolCalls[0].name).toBe('read_page');
    expect(posts()).toHaveLength(2);
    const last = posts()[1].body.messages.at(-1);
    expect(last).toMatchObject({ role: 'user', content: expect.stringContaining('could not be used') });
  });

  it('gives up with a clear error after repeated unusable replies, running no tool', async () => {
    server.script(textReply('nope'), textReply('still nope'), textReply('no'));
    const events = await run(adapter());
    expect(errorOf(events)).toMatchObject({ code: 'invalid_request', message: expect.stringMatching(/usable action/) });
    expect(doneOf(events)).toBeUndefined();
    expect(posts()).toHaveLength(3);
  });

  it('asks again when an encoded value is broken, rather than storing it', async () => {
    server.script(envelopeReply('set_value', { value: { $json: '{broken' } }), envelopeReply('set_value', { value: 'plain' }));
    expect(JSON.parse(doneOf(await run(adapter())).toolCalls[0].arguments)).toEqual({ value: 'plain' });
    expect(posts()).toHaveLength(2);
  });

  it('reads a reply wrapped in reasoning or a code fence when a server ignores the grammar', async () => {
    const env = JSON.stringify({ brief_status: 's', action: { tool: 'read_page', args: { pageId: 'p' } } });
    server.script(textReply(`<think>hmm {not this}</think>\n\`\`\`json\n${env}\n\`\`\``));
    expect(doneOf(await run(adapter())).toolCalls[0].name).toBe('read_page');
  });

  it('never runs a draft action from unfinished reasoning or surrounding prose', () => {
    const env = JSON.stringify({ brief_status: 's', action: { tool: 'apply_operations', args: { operations: [] } } });
    expect(parseEnvelope(`<think>maybe ${env}`).ok).toBe(false);
    expect(parseEnvelope(`Here is my plan: ${env} and then more`).ok).toBe(false);
  });

  it('rejects an envelope missing its status, arguments or finish message', () => {
    expect(parseEnvelope('{"action":{"tool":"read_page","args":{}}}').ok).toBe(false);
    expect(parseEnvelope('{"brief_status":"s","action":{"tool":"read_page"}}').ok).toBe(false);
    expect(parseEnvelope('{"brief_status":"Still working","action":{"tool":"finish"}}').ok).toBe(false);
    expect(parseEnvelope('{"brief_status":"Still working","action":{"tool":"finish","args":{"message":"  "}}}').ok).toBe(false);
  });

  it('replays a finish as an envelope on a repair turn', async () => {
    server.script(envelopeReply('finish', { message: 'All done.' }), envelopeReply('finish', { message: 'Fixed.' }));
    const a = adapter();
    const done = doneOf(await run(a));
    await run(a, { items: [{ kind: 'user', text: 'Hi' }, { kind: 'assistant', text: done.text, toolCalls: [], providerData: done.providerData }, { kind: 'user', text: 'Validation found new errors.' }] });
    expect(JSON.parse(posts()[1].body.messages[2].content).action.tool).toBe('finish');
  });

  it('ignores prose before a stray closing think tag, and keeps the tag inside a fenced object', () => {
    const env = JSON.stringify({ brief_status: 'a </think> b', action: { tool: 'finish', args: { message: 'Done.' } } });
    expect(parseEnvelope(`I will run this </think>${env}`).ok).toBe(false);
    expect(parseEnvelope(`\`\`\`json\n${env}\n\`\`\``)).toMatchObject({ ok: true, finish: 'Done.' });
  });

  it('honors a structured error parameter over the wording', async () => {
    server.script({ status: 400, body: JSON.stringify({ error: { message: 'Invalid model name grammar-local', param: 'model' } }) }, { status: 400, body: JSON.stringify({ error: { message: 'bad value', param: 'response_format.json_schema' } }) }, envelopeReply('read_page', { pageId: 'p' }));
    expect(errorOf(await run(adapter())).code).toBe('invalid_request');
    expect(posts()).toHaveLength(1);
    expect(doneOf(await run(adapter())).toolCalls).toHaveLength(1);
    // A refusal of the schema's content gets the schema written out in full, still as a grammar.
    expect(posts().at(-1)?.body.response_format).toMatchObject({ type: 'json_schema', json_schema: { schema: envelopeSchema(TOOLS) } });
  });

  it('takes a structured parameter over wording that would otherwise step down', async () => {
    server.script({ status: 400, body: JSON.stringify({ error: { message: 'Failed to parse grammar for model', param: 'model' } }) }, { status: 400, body: JSON.stringify({ error: { message: 'JSON schema conversion failed: $ref', param: 'model' } }) });
    expect(errorOf(await run(adapter())).code).toBe('invalid_request');
    expect(errorOf(await run(adapter())).code).toBe('invalid_request');
    expect(posts()).toHaveLength(2);
  });

  it('tries the full schema once for a refusal it cannot place, then reports it without giving up the grammar', async () => {
    const refusal = { status: 400, body: JSON.stringify({ error: { message: 'Invalid model name: schema-demo' } }) };
    server.script(refusal, refusal);
    expect(errorOf(await run(adapter())).code).toBe('invalid_request');
    // The full schema is exactly what was sent before compact schemas; a model name is no reason to drop the grammar.
    expect(posts().map((p) => p.body.response_format?.json_schema?.schema)).toEqual([envelopeSchema(TOOLS, { compact: true }), envelopeSchema(TOOLS)]);
  });

  it('still gives up the format when its refusal mentions the context window, as before', async () => {
    server.script({ status: 400, body: JSON.stringify({ error: { message: 'response_format is unsupported for this context window' } }) }, envelopeReply('read_page', { pageId: 'p' }));
    expect(doneOf(await run(adapter())).toolCalls[0].name).toBe('read_page');
    expect(posts().map((r) => r.body.response_format?.type)).toEqual(['json_schema', 'json_object']);
  });

  it('skips the full schema when the wording refuses the format itself', async () => {
    server.script({ status: 400, body: JSON.stringify({ error: { message: 'response_format of type json_schema is not supported' } }) }, envelopeReply('read_page', { pageId: 'p' }));
    expect(doneOf(await run(adapter())).toolCalls[0].name).toBe('read_page');
    expect(posts().map((r) => r.body.response_format?.type)).toEqual(['json_schema', 'json_object']);
  });

  it('gives up the grammar at once when the server refuses the format itself', async () => {
    server.script({ status: 400, body: JSON.stringify({ error: { message: 'bad value', param: 'response_format' } }) }, { status: 400, body: JSON.stringify({ error: { message: 'response_format type not supported' } }) }, envelopeReply('read_page', { pageId: 'p' }));
    expect(doneOf(await run(adapter())).toolCalls[0].name).toBe('read_page');
    expect(posts().map((r) => r.body.response_format?.type)).toEqual(['json_schema', 'json_object', undefined]);
  });

  it('keeps the grammar when a 400 merely mentions the word', async () => {
    const refusal = { status: 400, body: JSON.stringify({ error: { message: 'Unknown model grammar-demo' } }) };
    server.script(refusal, refusal);
    expect(errorOf(await run(adapter())).code).toBe('invalid_request');
    // One try with the full schema (what was sent before compact schemas), never without the grammar.
    expect(posts().map((p) => p.body.response_format?.type)).toEqual(['json_schema', 'json_schema']);
  });

  it('does not strip text that merely mentions a think tag inside the JSON', () => {
    const env = JSON.stringify({ brief_status: 'a </think> b', action: { tool: 'finish', args: { message: 'kept </think> text' } } });
    expect(parseEnvelope(env)).toMatchObject({ ok: true, finish: 'kept </think> text' });
  });

  it('executes nothing from a truncated envelope', async () => {
    const whole = JSON.stringify({ brief_status: 'Working', action: { tool: 'read_page', args: { pageId: 'pg_home' } } });
    server.script(textReply(whole.slice(0, 40), { finish: 'length' }));
    expect(doneOf(await run(adapter()))).toMatchObject({ stopReason: 'max_tokens', toolCalls: [] });
    expect(posts()).toHaveLength(1);
  });

  it('steps down the response format when the server refuses it', async () => {
    server.script(
      { status: 400, body: JSON.stringify({ error: { message: 'Failed to parse grammar' } }) },
      { status: 400, body: JSON.stringify({ error: { message: 'response_format type not supported' } }) },
      { status: 400, body: JSON.stringify({ error: { message: 'response_format type not supported' } }) },
      envelopeReply('read_page', { pageId: 'p' })
    );
    expect(doneOf(await run(adapter())).toolCalls[0].name).toBe('read_page');
    expect(posts().map((r) => r.body.response_format?.type)).toEqual(['json_schema', 'json_schema', 'json_object', undefined]);
    expect(posts()[0].body.response_format.json_schema.schema).toEqual(envelopeSchema(TOOLS, { compact: true }));
    expect(posts()[1].body.response_format.json_schema.schema).toEqual(envelopeSchema(TOOLS));
  });

  it('sends the code fixer, which has no tools, as plain chat', async () => {
    const fixed = '<script>\n  let { heading = "Hi" } = $props();\n</script>\n\n<h2>{heading}</h2>\n';
    server.script(textReply(`Replaced the old prop syntax.\n\`\`\`svelte\n${fixed}\`\`\``));
    const check = async (src: string) => (src.includes('export let') ? [{ severity: 'error', message: 'Use $props', line: 2 }] : []);
    const r = await fixComponentSource(adapter(), 'test-model', '<script>\n  export let heading = "Hi";\n</script>\n\n<h2>{heading}</h2>\n', check, new AbortController().signal);
    expect(r.ok).toBe(true);
    expect(r.source).toContain('$props');
    expect(posts()[0].body.response_format).toBeUndefined();
  });

  it('offers clearing the size in Settings only when the server reports its own, not one learned from an error', async () => {
    server.script({ status: 400, body: JSON.stringify({ error: { code: 400, message: 'request (8200 tokens) exceeds the available context size (16384 tokens)', type: 'exceed_context_size_error', n_prompt_tokens: 8200, n_ctx: 16384 } }) });
    const a = adapter({ contextWindow: 4096 });
    await run(a);
    expect(a.contextHelp(32768)).toMatch(/context size set in Settings, 4,096 tokens/);
    expect(a.contextHelp(32768)).not.toMatch(/clear it/);
  });

  it('does not ask for a fix whose corrected copy cannot fit in one reply', async () => {
    const source = `<script>\n  export let heading = "Hi";\n</script>\n\n<p>${'words '.repeat(7000)}</p>\n`;
    const r = await fixComponentSource(adapter({ contextWindow: 200_000 }), 'test-model', source, async () => [{ severity: 'error', message: 'Use $props' }], new AbortController().signal);
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/write back in one reply.*limited to 8,192/) });
    expect(posts()).toHaveLength(0);
  });

  it('does not send a component a known window cannot hold twice, and fits the reply otherwise', async () => {
    const source = `<script>\n  export let heading = "Hi";\n</script>\n\n<h2>{heading}</h2>\n<p>${'words '.repeat(1500)}</p>\n`;
    const check = async (src: string) => (src.includes('export let') ? [{ severity: 'error', message: 'Use $props' }] : []);
    const small = await fixComponentSource(adapter({ contextWindow: 4096 }, { context: { server: 'ollama', windowTokens: 4096 } }), 'test-model', source, check, new AbortController().signal);
    expect(small).toMatchObject({ ok: false, message: expect.stringMatching(/too long to fix with the model's 4,096-token context.*OLLAMA_CONTEXT_LENGTH/) });
    expect(posts()).toHaveLength(0);
    server.script(textReply(`Fixed.\n\`\`\`svelte\n${source.replace('export let heading = "Hi";', 'let { heading = "Hi" } = $props();')}\`\`\``));
    const roomy = await fixComponentSource(adapter({ contextWindow: 8192 }), 'test-model', source, check, new AbortController().signal);
    expect(roomy.ok).toBe(true);
    expect(posts()[0].body.max_tokens).toBeLessThan(DEFAULT_LOCAL_PROFILE.maxOutput);
    expect(posts()[0].body.max_tokens).toBeGreaterThan(Math.ceil(source.length / 4));
  });

  it('does not accept a fix from a reply that was cut off', async () => {
    const draft = '<script>\n  let { heading = "Hi" } = $props();\n</script>\n\n<h2>{heading}</h2>\n';
    server.script(textReply(`Fixed.\n\`\`\`svelte\n${draft}\`\`\`\nAlso`, { finish: 'length' }));
    const r = await fixComponentSource(adapter(), 'test-model', '<script>\n  export let heading = "Hi";\n</script>\n', async (src) => (src.includes('export let') ? [{ severity: 'error', message: 'Use $props' }] : []), new AbortController().signal);
    expect(r.ok).toBe(false);
  });

  it('reads the status of a partial reply', () => {
    expect(partialStatus('{"brief_status":"Upd')).toEqual({ text: 'Upd', complete: false });
    expect(partialStatus('{"brief_status":"a\\"b","action"')).toEqual({ text: 'a"b', complete: true });
    expect(partialStatus('{"brief_status":"tail\\')).toEqual({ text: 'tail', complete: false });
    expect(partialStatus('{"brief_status":"x\\u00')).toEqual({ text: 'x', complete: false });
    expect(partialStatus('{"action":')).toBeNull();
  });

  it('writes readable signatures', () => {
    expect(signature(toStrictSchema({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'array', items: { enum: ['x', 'y'] } }, c: {} }, required: ['a'] }))).toBe('{a!,b:(x|y)[],c:json}');
  });
});

describe('the mock server', () => {
  it('listens on a port it is given, and refuses one that is taken', async () => {
    const port = Number(new URL(server.baseURL).port);
    const second = new MockOpenAIServer();
    await expect(second.start(port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await server.stop();
    await second.start(port);
    expect(second.baseURL).toBe(`http://127.0.0.1:${port}/v1`);
    server = second;
  });
});

describe('the loaded context window', () => {
  const llama = (prompt: number, ctx: number) => JSON.stringify({ error: { code: 400, message: `request (${prompt} tokens) exceeds the available context size (${ctx} tokens), try increasing it`, type: 'exceed_context_size_error', n_prompt_tokens: prompt, n_ctx: ctx } });
  const vllm = (window: number, messages: number, completion: number) =>
    JSON.stringify({ object: 'error', message: `This model's maximum context length is ${window} tokens. However, you requested ${messages + completion} tokens (${messages} in the messages, ${completion} in the completion). Please reduce the length of the messages or completion.`, type: 'BadRequestError', param: null, code: 400 });

  it("reads the numbers in each server's context error", () => {
    expect(contextOverflow(llama(8200, 4096))).toEqual({ windowTokens: 4096, promptTokens: 8200, server: 'llama.cpp' });
    expect(contextOverflow(JSON.stringify({ error: { message: 'request (5000 tokens) exceeds the available context size (4096 tokens), try increasing it' } }))).toEqual({ windowTokens: 4096, promptTokens: 5000, server: 'llama.cpp' });
    expect(contextOverflow(vllm(8192, 6000, 4000))).toEqual({ windowTokens: 8192, promptTokens: 6000, server: 'vllm' });
    expect(contextOverflow(JSON.stringify({ object: 'error', message: "This model's maximum context length is 8192 tokens. However, your request has 6000 input tokens and asks for 4000 output tokens." }))).toEqual({ windowTokens: 8192, promptTokens: 6000, server: 'vllm' });
    expect(contextOverflow(JSON.stringify({ error: 'Maximum context size is 4096, but 7302 tokens were provided' }))).toEqual({ windowTokens: 4096, promptTokens: 7302, server: 'lm-studio' });
    // "The first N tokens" are only what the server tried to keep, not the whole prompt.
    const kept = contextOverflow(JSON.stringify({ error: 'Trying to keep the first 7302 tokens when context the overflows. However, the model is loaded with context length of only 4096 tokens, which is not enough.' }));
    expect(kept).toEqual({ windowTokens: 4096, server: 'lm-studio' });
    expect(contextOverflow(JSON.stringify({ error: { message: 'the request exceeds the available context size' } }))).toEqual({ server: 'llama.cpp' });
  });

  it("reads llama.cpp's loaded size from /props, not its training size", async () => {
    server.models = { data: [{ id: 'test-model', meta: { n_ctx_train: 131072 } }] };
    server.routes['/props'] = { body: { default_generation_settings: { n_ctx: 4096 }, total_slots: 1 } };
    expect(await discoverLocalContext({ baseURL: server.baseURL, model: 'test-model' })).toEqual({ windowTokens: 4096, server: 'llama.cpp' });
  });

  it('ignores /props when the server lists several models', async () => {
    server.models = { data: [{ id: 'test-model' }, { id: 'other' }] };
    server.routes['/props'] = { body: { default_generation_settings: { n_ctx: 4096 } } };
    expect(await discoverLocalContext({ baseURL: server.baseURL, model: 'test-model' })).toEqual({});
  });

  it("reads llama.cpp's per-model metadata and vLLM's max_model_len", async () => {
    server.models = { data: [{ id: 'test-model', meta: { n_ctx: 16384, n_ctx_train: 131072 } }, { id: 'other', meta: { n_ctx: 2048 } }] };
    expect(await discoverLocalContext({ baseURL: server.baseURL, model: 'test-model' })).toEqual({ windowTokens: 16384, server: 'llama.cpp' });
    server.models = { data: [{ id: 'test-model', max_model_len: 8192 }] };
    expect(await discoverLocalContext({ baseURL: server.baseURL, model: 'test-model' })).toEqual({ windowTokens: 8192, server: 'vllm' });
  });

  it("reads LM Studio's loaded size, not the model's maximum", async () => {
    server.routes['/api/v0/models/org%2Fmodel'] = { body: { id: 'org/model', state: 'loaded', max_context_length: 262144, loaded_context_length: 8192 } };
    server.models = { data: [{ id: 'org/model' }] };
    expect(await discoverLocalContext({ baseURL: server.baseURL, model: 'org/model' })).toEqual({ windowTokens: 8192, server: 'lm-studio' });
  });

  it("reads Ollama's running model, and only that model", async () => {
    server.routes['/api/ps'] = { body: { models: [{ name: 'other:latest', model: 'other:latest', context_length: 65536 }, { name: 'test-model', model: 'test-model', context_length: 4096 }] } };
    expect(await discoverLocalContext({ baseURL: server.baseURL, model: 'test-model' })).toEqual({ windowTokens: 4096, server: 'ollama' });
    server.routes['/api/ps'] = { body: { models: [{ name: 'other:latest', context_length: 65536 }] } };
    expect(await discoverLocalContext({ baseURL: server.baseURL, model: 'test-model' })).toEqual({});
  });

  it('gives up on a slow report within its deadline, and sends the key only to the saved server', async () => {
    server.routes['/props'] = { body: { default_generation_settings: { n_ctx: 4096 } }, delayMs: 2000 };
    const started = Date.now();
    expect(await discoverLocalContext({ baseURL: server.baseURL, model: 'test-model', apiKey: 'local-secret' }, { timeoutMs: 100 })).toEqual({});
    expect(Date.now() - started).toBeLessThan(1000);
    const gets = server.requests.filter((r) => r.method === 'GET');
    expect(gets.map((r) => r.url).sort()).toEqual(['/api/ps', '/api/v0/models/test-model', '/props', '/v1/models']);
    expect(gets.every((r) => r.headers.authorization === 'Bearer local-secret')).toBe(true);
  });

  it('asks nothing with a cloud key, or of a localhost that is not this computer', async () => {
    const cloud = `sk-proj-${'Ab3_dE6-gH9'.repeat(5)}`;
    expect(await discoverLocalContext({ baseURL: server.baseURL, model: 'test-model', apiKey: cloud })).toEqual({});
    const elsewhere = async () => [{ address: '203.0.113.7' }];
    const localhost = server.baseURL.replace('127.0.0.1', 'localhost');
    expect(await discoverLocalContext({ baseURL: localhost, model: 'test-model' }, { lookup: elsewhere })).toEqual({});
    expect(server.requests).toEqual([]);
  });

  it("keeps the localhost check within the discovery deadline", async () => {
    const stalled = () => new Promise<Array<{ address: string }>>(() => undefined);
    const started = Date.now();
    expect(await discoverLocalContext({ baseURL: server.baseURL.replace('127.0.0.1', 'localhost'), model: 'test-model' }, { lookup: stalled, timeoutMs: 50 })).toEqual({});
    expect(Date.now() - started).toBeLessThan(1000);
    expect(server.requests).toEqual([]);
  });

  it('lists nothing once the run is stopped', async () => {
    const stopped = new AbortController();
    stopped.abort();
    expect(await openLocalAdapter({ baseURL: server.baseURL, model: '' }, { signal: stopped.signal })).toEqual({ error: 'Canceled' });
    expect(await listLocalModels({ baseURL: server.baseURL }, { signal: stopped.signal })).toMatchObject({ ok: false });
    expect(server.requests).toEqual([]);
  });

  it('asks a remote server nothing unless it is allowed', async () => {
    let calls = 0;
    const fetch = (async () => {
      calls++;
      return new Response('{}');
    }) as typeof globalThis.fetch;
    expect(await discoverLocalContext({ baseURL: 'http://example.com/v1', model: 'm' }, { fetch })).toEqual({});
    expect(calls).toBe(0);
  });

  it('uses the smaller of the size in Settings and the size the server reports', () => {
    expect(adapter({ contextWindow: 32768 }, { context: { windowTokens: 4096 } }).capabilities()).toMatchObject({ contextWindowTokens: 4096, contextWindowKnown: true });
    expect(adapter({ contextWindow: 8192 }, { context: { windowTokens: 32768 } }).capabilities()).toMatchObject({ contextWindowTokens: 8192, contextWindowKnown: true });
    expect(adapter({ contextWindow: 12288 }).capabilities()).toMatchObject({ contextWindowTokens: 12288, contextWindowKnown: true });
    // A guess is not knowledge: the profile's size is only an assumption.
    expect(adapter().capabilities()).toMatchObject({ contextWindowTokens: DEFAULT_LOCAL_PROFILE.contextWindow, contextWindowKnown: false });
    expect(adapter({ contextWindow: 'lots' as unknown as number }).capabilities()).toMatchObject({ contextWindowKnown: false });
  });

  it('only accepts a whole number of tokens in a usable range from Settings', () => {
    expect(localContextWindow(4096)).toBe(4096);
    expect(localContextWindow(LOCAL_CONTEXT_MIN)).toBe(LOCAL_CONTEXT_MIN);
    expect(localContextWindow(LOCAL_CONTEXT_MAX)).toBe(LOCAL_CONTEXT_MAX);
    for (const bad of [null, undefined, '4096', 4096.5, LOCAL_CONTEXT_MIN - 1, LOCAL_CONTEXT_MAX + 1, -1, Number.NaN]) expect(localContextWindow(bad)).toBeNull();
  });

  it('reads a typed size strictly', () => {
    expect(parseContextSize('')).toEqual({ ok: true, value: null });
    expect(parseContextSize('  ')).toEqual({ ok: true, value: null });
    expect(parseContextSize(' 8192 ')).toEqual({ ok: true, value: 8192 });
    expect(parseContextSize('32,768')).toEqual({ ok: true, value: 32768 });
    for (const bad of ['4096,5', ',', '8 192', '1,0000', '8192.0', '-8192', '512', 'auto']) expect(parseContextSize(bad)).toEqual({ ok: false });
  });

  it("opens a run's adapter with the server's only model and its loaded size", async () => {
    server.models = { data: [{ id: 'only-model' }] };
    server.routes['/props'] = { body: { default_generation_settings: { n_ctx: 4096 } } };
    const opened = await openLocalAdapter({ baseURL: server.baseURL, model: '' });
    if ('error' in opened) throw new Error(opened.error);
    expect(opened.model).toBe('only-model');
    expect(opened.adapter.capabilities()).toMatchObject({ contextWindowTokens: 4096, contextWindowKnown: true });
    const capped = await openLocalAdapter({ baseURL: server.baseURL, model: 'only-model', contextWindow: 2048 });
    expect('adapter' in capped && capped.adapter.capabilities().contextWindowTokens).toBe(2048);
  });

  it('asks the server nothing more once the run is stopped', async () => {
    const stopped = new AbortController();
    stopped.abort();
    const opened = await openLocalAdapter({ baseURL: server.baseURL, model: 'test-model' }, { signal: stopped.signal });
    expect('adapter' in opened && opened.adapter.capabilities().contextWindowKnown).toBe(false);
    expect(server.requests).toHaveLength(0);
    // A Stop during discovery ends the probes then, not at the deadline.
    server.routes['/props'] = { body: { default_generation_settings: { n_ctx: 4096 } }, delayMs: 3000 };
    const ctl = new AbortController();
    const started = Date.now();
    setTimeout(() => ctl.abort(), 50);
    expect(await discoverLocalContext({ baseURL: server.baseURL, model: 'test-model' }, { signal: ctl.signal, timeoutMs: 2000 })).toEqual({});
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('keeps a retried reply within the size in Settings', async () => {
    server.script({ status: 400, body: vllm(10000, 7500, 4000) }, textReply('Fits.'));
    await run(native({}, { contextWindow: 9000 }), { tools: [] });
    expect(posts().map((p) => p.body.max_tokens)).toEqual([4000, 1500]);
  });

  it('retries once with a reply that fits when the server counts the reply against the window', async () => {
    server.script({ status: 400, body: vllm(8192, 6000, 4000) }, textReply('Fits now.'));
    const a = native();
    const events = await run(a, { tools: [] });
    expect(doneOf(events)).toMatchObject({ stopReason: 'end', text: 'Fits now.' });
    expect(posts().map((p) => p.body.max_tokens)).toEqual([4000, 2192]);
    expect(posts()[1].body.messages).toEqual(posts()[0].body.messages);
    // What the server said stays with the adapter for the rest of the run.
    expect(a.capabilities().contextWindowTokens).toBe(8192);
  });

  it('does not retry when a smaller reply cannot help', async () => {
    server.script({ status: 400, body: llama(8200, 4096) });
    const a = adapter();
    const error = errorOf(await run(a));
    expect(error).toMatchObject({ code: 'invalid_request', message: expect.stringMatching(/context window/), context: { windowTokens: 4096, promptTokens: 8200 } });
    expect(error.message).not.toMatch(/new conversation/i);
    expect(posts()).toHaveLength(1);
    expect(a.capabilities()).toMatchObject({ contextWindowTokens: 4096, contextWindowKnown: true });
    expect(a.contextHelp(32768)).toMatch(/--ctx-size 32768/);
  });

  it('retries a smaller reply only once', async () => {
    server.script({ status: 400, body: vllm(8192, 6000, 4000) }, { status: 400, body: vllm(8192, 6100, 2192) });
    expect(errorOf(await run(native(), { tools: [] }))).toMatchObject({ code: 'invalid_request', context: { windowTokens: 8192, promptTokens: 6100 } });
    expect(posts()).toHaveLength(2);
  });

  it('reports a context error sent inside the stream with its numbers', async () => {
    server.script({ frames: [`error: ${llama(5000, 4096).slice('{"error":'.length, -1)}\n\n`] });
    expect(errorOf(await run(native(), { tools: [] }))).toMatchObject({ code: 'invalid_request', context: { windowTokens: 4096, promptTokens: 5000 } });
  });

  it("explains each server's setting, or the one in Settings when that is what binds", () => {
    expect(adapter({}, { context: { server: 'ollama', windowTokens: 4096 } }).contextHelp(32768)).toMatch(/OLLAMA_CONTEXT_LENGTH=32768/);
    expect(adapter({}, { context: { server: 'lm-studio', windowTokens: 4096 } }).contextHelp(32768)).toMatch(/Context Length/);
    expect(adapter({}, { context: { server: 'vllm', windowTokens: 4096 } }).contextHelp(32768)).toMatch(/--max-model-len 32768/);
    expect(adapter().contextHelp(32768)).toMatch(/Advanced server options/);
    const capped = adapter({ contextWindow: 4096 }, { context: { server: 'llama.cpp', windowTokens: 65536 } }).contextHelp(32768);
    expect(capped).toMatch(/already has the model loaded with 65,536 tokens/);
    expect(capped).toMatch(/context size set in Settings, 4,096 tokens/);
    expect(capped).not.toMatch(/--ctx-size/);
    // Both hold the model back: reloading the server alone would leave the size in Settings in force.
    const both = adapter({ contextWindow: 4096 }, { context: { server: 'llama.cpp', windowTokens: 4096 } }).contextHelp(32768);
    expect(both).toMatch(/--ctx-size 32768/);
    expect(both).toMatch(/context size set in Settings, 4,096 tokens/);
    // Clearing the size in Settings would only fall back to a guess when the server does not report one.
    const unreported = adapter({ contextWindow: 4096 }).contextHelp(32768);
    expect(unreported).toMatch(/raise it under Advanced server options to the size the model is loaded with/);
    expect(unreported).not.toMatch(/clear it/);
    expect(capped).toMatch(/or clear it to use the size the server reports/);
    const roomy = adapter({ contextWindow: 65536 }, { context: { server: 'llama.cpp', windowTokens: 4096 } }).contextHelp(32768);
    expect(roomy).toMatch(/--ctx-size 32768/);
    expect(roomy).not.toMatch(/Settings/);
  });

  it('retries a smaller reply for a context error sent in the stream before any of the reply', async () => {
    const streamed = (message: string) => `error: ${JSON.stringify({ code: 400, message })}\n\n`;
    const tooLong = JSON.parse(vllm(8192, 6000, 4000)).message as string;
    server.script({ frames: [streamed(tooLong)] }, textReply('Fits now.'));
    expect(doneOf(await run(native(), { tools: [] }))).toMatchObject({ text: 'Fits now.' });
    expect(posts().map((p) => p.body.max_tokens)).toEqual([4000, 2192]);
    // Once part of the reply has arrived, asking again would show it twice.
    server.script({ frames: [sseChunk({ content: 'Partial' }), streamed(tooLong)] });
    expect(errorOf(await run(native(), { tools: [] }))).toMatchObject({ code: 'invalid_request', context: { windowTokens: 8192, promptTokens: 6000 } });
    expect(posts()).toHaveLength(3);
  });

  it('keeps a smaller reply within the size set in Settings', async () => {
    server.script({ status: 400, body: vllm(10000, 7500, 3000) });
    const a = native({}, { contextWindow: 8192 });
    // 8,192 in Settings leaves 692 tokens beside the 7,500-token prompt: too little to be worth a retry.
    expect(errorOf(await run(a, { tools: [], maxOutputTokens: 3000 }))).toMatchObject({ code: 'invalid_request', context: { windowTokens: 10000, promptTokens: 7500 } });
    expect(posts()).toHaveLength(1);
    expect(a.capabilities().contextWindowTokens).toBe(8192);
  });

  it('does not retry a smaller reply once the turn has asked for a correction', async () => {
    server.script(textReply('not json at all'), { status: 400, body: vllm(8192, 6000, 4000) });
    const error = errorOf(await run(adapter()));
    // The count includes the correction, so it is not passed on as the size of the caller's request.
    expect(error).toMatchObject({ code: 'invalid_request', context: { windowTokens: 8192, retried: true } });
    expect(error.context?.promptTokens).toBeUndefined();
    expect(posts()).toHaveLength(2);
  });

  it("takes llama.cpp's /props only for the model chosen", async () => {
    server.models = { data: [{ id: 'other' }] };
    server.routes['/props'] = { body: { default_generation_settings: { n_ctx: 4096 } } };
    expect(await discoverLocalContext({ baseURL: server.baseURL, model: 'test-model' })).toEqual({});
    server.models = 'not json';
    expect(await discoverLocalContext({ baseURL: server.baseURL, model: 'test-model' })).toEqual({});
  });

  it('never throws or outlives its deadline', async () => {
    const hanging = (() => new Promise<Response>(() => undefined)) as typeof globalThis.fetch;
    const started = Date.now();
    expect(await discoverLocalContext({ baseURL: server.baseURL, model: 'test-model' }, { fetch: hanging, timeoutMs: 50 })).toEqual({});
    expect(Date.now() - started).toBeLessThan(1000);
    expect(await discoverLocalContext({ baseURL: server.baseURL, model: 'bad\uD800id' }, { timeoutMs: 200 })).toEqual({});
  });

  it('names the loaded size when a connection is tested', async () => {
    // The test sends one short chat request each time (#83), then reads the size.
    server.script(textReply('OK'), textReply('OK'));
    server.routes['/props'] = { body: { default_generation_settings: { n_ctx: 4096 } } };
    expect(await testLocal({ baseURL: server.baseURL, model: 'test-model' })).toMatchObject({ ok: true, message: expect.stringMatching(/4,096-token context\. The assistant works best with 32,768 tokens or more/) });
    server.routes['/props'] = { body: { default_generation_settings: { n_ctx: 65536 } } };
    expect((await testLocal({ baseURL: server.baseURL, model: 'test-model' })).message).toBe('Connected. test-model answered a test chat request, loaded with a 65,536-token context.');
    expect(posts()).toHaveLength(2);
  });
});

describe('compact schemas on the wire (#364)', () => {
  const image = { type: 'object', properties: { assetId: { type: ['string', 'null'] }, alt: { type: 'string', maxLength: 300 } }, required: ['assetId', 'alt'] };
  const tone = { type: 'string', enum: ['default', 'muted', 'inverse'] };
  const SHARED: ToolDefinition[] = ['set_hero', 'set_logo', 'set_portrait'].map((name) => ({ name, description: name, parameters: { type: 'object', properties: { image, tone }, required: ['image'] } }));
  const schemaAt = (i: number) => posts()[i].body.response_format?.json_schema?.schema;
  const logo = { image: { assetId: null, alt: 'Logo' } };

  it.each([
    ['llama.cpp', { error: { code: 400, message: 'JSON schema conversion failed:\nUnrecognized schema: {"$ref":"#/$defs/d0"}', type: 'invalid_request_error' } }],
    ['vLLM (transform)', { object: 'error', message: 'Failed to transform json schema into a grammar: rule not found', type: 'BadRequestError', param: null, code: 400 }],
    ['a server naming the format and the reference', { error: { message: 'response_format rejected schema type: unresolved $ref #/$defs/d0' } }],
    ['vLLM', { object: 'error', message: 'The provided JSON schema contains features not supported by xgrammar.', type: 'BadRequestError', param: null, code: 400 }],
    ['Ollama', { error: 'invalid JSON schema in format' }],
    ['a structured parameter', { error: { message: 'bad value', param: 'response_format.json_schema.schema' } }]
  ])('writes the schema out in full when %s refuses its shared definitions, and keeps it so', async (_server, refusal) => {
    server.script({ status: 400, body: JSON.stringify(refusal) }, envelopeReply('set_logo', logo), envelopeReply('finish', { message: 'Done.' }));
    const a = adapter();
    expect(doneOf(await run(a, { tools: SHARED })).toolCalls[0]).toMatchObject({ name: 'set_logo', arguments: JSON.stringify(logo) });
    expect(Object.keys(schemaAt(0).$defs)).not.toHaveLength(0);
    expect(findForbiddenShapes(schemaAt(0))).toEqual([]);
    expect(schemaAt(1)).toEqual(envelopeSchema(SHARED));
    // Nothing the full schema accepts is lost in the compact one.
    expect(inlineDefinitions(schemaAt(0))).toEqual(dropEnumTypes(schemaAt(1)));
    // The adapter remembers: the next turn starts from the full schema.
    await run(a, { tools: SHARED });
    expect(schemaAt(2)).toEqual(envelopeSchema(SHARED));
  });

  it('keeps the compact schema when a refusal is about something else', async () => {
    server.script(
      { status: 400, body: JSON.stringify({ error: { code: 400, message: 'request (9000 tokens) exceeds the available context size (4096 tokens), try increasing it', type: 'exceed_context_size_error', n_prompt_tokens: 9000, n_ctx: 4096 } }) },
      // Worded so it would also read as a schema refusal: the context check comes first.
      { status: 400, body: JSON.stringify({ error: { message: 'Context length exceeded after JSON schema conversion' } }) },
      envelopeReply('set_logo', logo)
    );
    const a = adapter();
    expect(errorOf(await run(a, { tools: SHARED }))).toMatchObject({ code: 'invalid_request', context: { windowTokens: 4096, promptTokens: 9000 } });
    expect(errorOf(await run(a, { tools: SHARED })).code).toBe('invalid_request');
    expect(posts()).toHaveLength(2);
    // The same adapter still sends the compact form.
    await run(a, { tools: SHARED });
    expect(posts().map((_, i) => !!schemaAt(i).$defs)).toEqual([true, true, true]);
  });

  it.each([
    ['a validation wording', { error: { message: 'JSON schema validation failed: definitions must be inline' } }],
    ['a keyword named beside the format', { error: { message: 'Unsupported JSON schema keyword in response_format: definitions' } }],
    ['wording nothing here knows', { error: { message: 'Bad request' } }]
  ])('gives the full schema a try for %s', async (_case, refusal) => {
    server.script({ status: 400, body: JSON.stringify(refusal) }, envelopeReply('set_logo', logo));
    expect(doneOf(await run(adapter(), { tools: SHARED })).toolCalls[0].name).toBe('set_logo');
    expect(schemaAt(1)).toEqual(envelopeSchema(SHARED));
  });

  it('shortens the reply, keeping the compact schema, when a context error happens to quote a reference', async () => {
    server.script({ status: 400, body: JSON.stringify({ error: { code: 400, message: 'Context length exceeded. Prompt contains $ref.', type: 'exceed_context_size_error', n_ctx: 4096, n_prompt_tokens: 2800 } }) }, envelopeReply('set_logo', logo));
    expect(doneOf(await run(adapter(), { tools: SHARED, maxOutputTokens: 2048 })).toolCalls[0].name).toBe('set_logo');
    expect(posts().map((p) => [p.body.max_tokens, !!schemaAt(posts().indexOf(p)).$defs])).toEqual([
      [2048, true],
      [1296, true]
    ]);
  });

  it.each([400, 422])('steps on to JSON mode when the full schema is refused the same way (%i)', async (status) => {
    const refusal = { status, body: JSON.stringify({ error: 'invalid JSON schema in format' }) };
    server.script(refusal, refusal, envelopeReply('set_logo', logo));
    expect(doneOf(await run(adapter(), { tools: SHARED })).toolCalls[0].name).toBe('set_logo');
    expect(posts().map((p) => p.body.response_format?.type)).toEqual(['json_schema', 'json_schema', 'json_object']);
    expect(schemaAt(1)).toEqual(envelopeSchema(SHARED));
  });

  it('writes the schema out in full when the stream reports it could not build the compact grammar', async () => {
    server.script({ frames: [`data: ${JSON.stringify({ error: { code: 500, message: 'Failed to compile grammar: unresolved $ref #/$defs/d0' } })}\n\n`] }, envelopeReply('set_logo', logo));
    expect(doneOf(await run(adapter(), { tools: SHARED })).toolCalls[0].name).toBe('set_logo');
    expect(schemaAt(0).$defs).toBeDefined();
    expect(schemaAt(1)).toEqual(envelopeSchema(SHARED));
  });

  it.each([
    ['not about the schema', { code: 500, message: 'Model crashed' }],
    ['about the request length', { code: 500, message: 'Context length exceeded after JSON schema conversion' }],
    ['about another parameter', { code: 500, message: 'Failed to parse grammar for model', param: 'model' }]
  ])('reports a stream error %s as it is, and keeps the compact schema', async (_case, error) => {
    server.script({ frames: [`data: ${JSON.stringify({ error })}\n\n`] }, envelopeReply('set_logo', logo));
    const a = adapter();
    expect(errorOf(await run(a, { tools: SHARED }))).toBeDefined();
    expect(posts()).toHaveLength(1);
    await run(a, { tools: SHARED });
    expect(schemaAt(1).$defs).toBeDefined();
  });

  it('never asks again for a reply the stream had already started showing', async () => {
    server.script({ frames: [sseChunk({ role: 'assistant' }), sseChunk({ content: '{"brief_status":"Setting' }), `data: ${JSON.stringify({ error: { code: 500, message: 'Failed to compile grammar: unresolved $ref' } })}\n\n`] });
    expect(errorOf(await run(adapter(), { tools: SHARED }))).toBeDefined();
    expect(posts()).toHaveLength(1);
  });

  it('steps through every level, stream options included, within one turn', async () => {
    server.script(
      { status: 400, body: JSON.stringify({ error: { message: 'unknown field stream_options' } }) },
      { status: 400, body: JSON.stringify({ error: { message: 'JSON schema conversion failed: $ref' } }) },
      { status: 400, body: JSON.stringify({ error: { message: 'Failed to parse grammar' } }) },
      { status: 400, body: JSON.stringify({ error: { message: 'response_format type not supported' } }) },
      envelopeReply('set_logo', logo)
    );
    expect(doneOf(await run(adapter(), { tools: SHARED })).toolCalls[0].name).toBe('set_logo');
    expect(posts().map((p) => [p.body.response_format?.type, !!p.body.response_format?.json_schema?.schema.$defs, !!p.body.stream_options])).toEqual([
      ['json_schema', true, true],
      ['json_schema', true, false],
      ['json_schema', false, false],
      ['json_object', false, false],
      [undefined, false, false]
    ]);
    expect(schemaAt(1)).toEqual(envelopeSchema(SHARED, { compact: true }));
    expect(schemaAt(2)).toEqual(envelopeSchema(SHARED));
  });

  describe('reads the same tool call whatever the server enforces', () => {
    const sets = constrainedToolSets();
    const tools = (label: string) => sets.find((s) => s.label === label)!.tools;
    // A call per kind of run, with nested objects, lists, nulls, tokens and an encoded open value.
    const calls: Array<[string, string, Record<string, unknown>, Record<string, unknown>]> = [
      ['site', 'upsert_page_with_sections', { slug: 'services', sections: [{ componentId: 'hero.split', variants: { tone: 'muted' }, props: { heading: 'Hi', image: { assetId: null, alt: 'A room' } } }] }, {}],
      // A whole component (#359): nested rows, unions of a literal or a binding, and a table property, none encoded.
      [
        'site component',
        'upsert_managed_component',
        {
          name: 'Hours',
          properties: [{ type: 'table', name: 'hours', label: 'Hours', default: { columns: ['Day', 'Open'], rows: [['Mon', '9–5']] } }, { type: 'list', name: 'notes', label: 'Notes', fields: [{ type: 'string', name: 'text', label: 'Text' }], default: [{ values: [{ field: 'text', value: 'Closed on holidays' }] }] }],
          nodes: [{ kind: 'element', id: 'root', tag: 'section', children: ['title'], styles: [{ property: 'gap', value: { token: 'space.lg' } }, { property: 'gap', value: { token: 'space.xl' }, scope: 'desktop' }] }, { kind: 'text', id: 'title', tag: 'h2', text: 'Opening hours', when: { $prop: 'hours' } }],
          variantAxes: [{ name: 'tone', label: 'Tone', options: [{ id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark', styles: [{ nodeId: 'root', property: 'background', value: { token: 'color.inverse' } }] }] }],
          placeOnPage: { pageId: '/' }
        },
        {}
      ],
      ['component', 'upsert_managed_component', { name: 'Badge', nodes: [{ kind: 'element', id: 'root', children: ['label'] }, { kind: 'text', id: 'label', tag: 'span', text: { $prop: 'label' } }], properties: [{ type: 'string', name: 'label', label: 'Label', default: 'New' }] }, {}],
      ['selection', 'update_selected_props', { props: { heading: 'Sharper' }, variant: 'muted' }, {}],
      ['part', 'style_selected_element', { scope: 'phone', styles: [{ property: 'paddingBlock', value: { token: 'space.lg' } }, { property: 'color', value: null }] }, {}],
      ['ask', 'locate_field', { owner: { kind: 'page', id: 'pg_1' }, nodeId: 'n_1', prop: 'items', itemId: 'i_1', field: 'value' }, {}],
      // The SEO audit (#593), whole and narrowed, in a question and in each kind of edit run.
      ['ask', 'audit_seo', {}, {}],
      ['ask', 'audit_seo', { pageId: '/services/', pillar: 'content', offset: 40 }, {}],
      ['site', 'audit_seo', { pillar: 'technical' }, {}],
      ['page', 'audit_seo', { pageId: 'pg_1', linkOffset: 100 }, {}],
      ['general', 'audit_seo', { pageId: '/about/' }, {}],
      ['definition', 'style_definition_element', { partId: 'heading', variant: { axis: 'tone', option: 'muted' }, scope: 'phone', styles: [{ property: 'gap', value: { token: 'space.lg' } }, { property: 'color', value: null }] }, {}],
      ['definition', 'bind_definition_field', { nodeId: 'heading', field: 'when', binding: { $prop: 'heading' }, eq: 'Hi' }, {}],
      ['general (code)', 'apply_operations', { expectedRevision: 0, operations: [{ type: 'instance.setProp', owner: { kind: 'page', id: 'pg_1' }, nodeId: 'n_1', prop: 'items', value: { [OPEN_VALUE_KEY]: '[{"id":"i_1"}]' } }] }, { operations: [{ value: [{ id: 'i_1' }] }] }]
    ];
    const refusals = {
      compact: [],
      inline: [{ status: 400, body: JSON.stringify({ error: { message: 'Failed to parse grammar' } }) }],
      json_object: [{ status: 400, body: JSON.stringify({ error: { message: 'bad value', param: 'response_format' } }) }],
      none: [{ status: 400, body: JSON.stringify({ error: { message: 'bad value', param: 'response_format' } }) }, { status: 400, body: JSON.stringify({ error: { message: 'response_format type not supported' } }) }]
    };

    it.each(calls)('in a %s run: %s', async (label, name, wire, decodedPatch) => {
      const offered = tools(label);
      expect(offered.map((t) => t.name)).toContain(name);
      const decoded = JSON.parse(JSON.stringify(wire, (k, v) => (v && typeof v === 'object' && OPEN_VALUE_KEY in v ? JSON.parse(v[OPEN_VALUE_KEY]) : v)));
      expect(decoded).toMatchObject(decodedPatch);
      const seen: Array<{ name: string; arguments: string }> = [];
      for (const level of Object.values(refusals)) {
        server.script(...level, envelopeReply(name, wire));
        const call = doneOf(await run(adapter(), { tools: offered })).toolCalls[0];
        seen.push({ name: call.name, arguments: call.arguments });
      }
      server.script(toolCallReply(name, decoded));
      const nativeCall = doneOf(await run(native(), { tools: offered })).toolCalls[0];
      seen.push({ name: nativeCall.name, arguments: nativeCall.arguments });
      expect(seen).toEqual(Array(5).fill({ name, arguments: JSON.stringify(decoded) }));
      // The levels were what they claim: compact, then the full schema, then JSON mode, then nothing.
      const formats = posts().filter((p) => p.body.response_format || !p.body.tools).map((p) => [p.body.response_format?.type, !!p.body.response_format?.json_schema && JSON.stringify(p.body.response_format.json_schema.schema) === JSON.stringify(envelopeSchema(offered))]);
      expect(formats).toEqual([
        ['json_schema', false],
        ['json_schema', false],
        ['json_schema', true],
        ['json_schema', false],
        ['json_object', false],
        ['json_schema', false],
        ['json_object', false],
        [undefined, false]
      ]);
    });
  });
});
