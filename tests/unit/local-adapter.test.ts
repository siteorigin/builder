/** The local adapter against a real HTTP server speaking OpenAI-compatible SSE, including its failure shapes. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LocalAdapter, listLocalModels, testLocal, type LocalAdapterOptions, type LocalEndpoint } from '@agent/local';
import { envelopeSchema, parseEnvelope, partialStatus, signature } from '@agent/constrained';
import { findForbiddenShapes, toStrictSchema } from '@agent/strict-schema';
import { DEFAULT_LOCAL_PROFILE, localModelProfile, modelInfo } from '@agent/models';
import { toolDefinitions } from '@agent/tools';
import { fixComponentSource } from '@agent/fixer';
import { checkLocalBaseURL, LOCAL_PRESETS } from '@shared/local';
import type { CanonicalModelRequest, ModelEvent, ToolDefinition } from '@agent/types';
import { closedPort, DONE, envelopeReply, MockOpenAIServer, sseChunk, textReply, toolCallReply } from './mock-openai-server';

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

  it('tests a connection without generating anything', async () => {
    expect(await testLocal({ baseURL: server.baseURL, model: 'test-model' })).toMatchObject({ ok: true });
    expect(await testLocal({ baseURL: server.baseURL, model: '' })).toMatchObject({ ok: true, message: expect.stringContaining('test-model') });
    expect(await testLocal({ baseURL: server.baseURL, model: 'ghost' })).toMatchObject({ ok: false, message: expect.stringContaining('ghost') });
    server.models = { data: [] };
    expect(await testLocal({ baseURL: server.baseURL, model: '' })).toMatchObject({ ok: false, message: expect.stringMatching(/no models/) });
    expect(posts()).toHaveLength(0);
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
    expect(body.messages[0].content).toContain('read_page {pageId: string}');
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
    expect(JSON.parse(messages[2].content).action.args).toEqual({ value: { $json: '[1]' } });
    expect(messages[3].content).toContain('Result of set_value:\n{"ok":true}');
    expect(messages[3].content).toContain('Validation found new errors.');
  });

  it('replays an earlier request’s answer as a finish envelope, never as prose (#195)', async () => {
    // The server refuses the schema, then the JSON mode: every request still shows the history in the format.
    server.script(
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
    expect(posts().map((r) => r.body.response_format?.type)).toEqual(['json_schema', 'json_object', undefined]);
    for (const post of posts()) {
      const messages = post.body.messages as Array<{ role: string; content: string }>;
      expect(messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
      expect(parseEnvelope(messages[2].content)).toMatchObject({ ok: true, finish: 'Made the headline bolder.' });
      expect(messages[3].content).toBe('Which button?\n\nNow the button');
    }
    // Native tool calling keeps the plain text.
    await run(native(), { items: items.slice(0, 3) });
    expect(posts()[3].body.messages[2]).toEqual({ role: 'assistant', content: 'Made the headline bolder.' });
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
    expect(doneOf(await run(adapter())).toolCalls).toHaveLength(1);
    expect(posts().at(-1)?.body.response_format.type).toBe('json_object');
  });

  it('keeps the grammar when a 400 merely mentions the word', async () => {
    server.script({ status: 400, body: JSON.stringify({ error: { message: 'Unknown model grammar-demo' } }) });
    expect(errorOf(await run(adapter())).code).toBe('invalid_request');
    expect(posts()).toHaveLength(1);
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
      envelopeReply('read_page', { pageId: 'p' })
    );
    expect(doneOf(await run(adapter())).toolCalls[0].name).toBe('read_page');
    expect(posts().map((r) => r.body.response_format?.type)).toEqual(['json_schema', 'json_object', undefined]);
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
    expect(signature(toStrictSchema({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'array', items: { enum: ['x', 'y'] } }, c: {} }, required: ['a'] }))).toBe('{a: string, b?: ("x"|"y")[], c?: json}');
  });
});
