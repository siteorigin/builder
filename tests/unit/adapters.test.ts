/**
 * Wire-level tests for the provider adapters: each test replays the HTTP and server-sent-event traffic of
 * the OpenAI Responses API or the Anthropic Messages API through an injected fetch, so the adapters' own
 * request building and stream parsing are exercised without a provider.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIAdapter, testOpenAI } from '@agent/openai';
import { AnthropicAdapter, testAnthropic } from '@agent/anthropic';
import { fixComponentSource } from '@agent/fixer';
import type { CanonicalModelRequest, ModelEvent, ToolDefinition } from '@agent/types';
import { MockOpenAIServer } from './mock-openai-server';

type Sse = { event?: string; data: unknown };

function sse(events: Sse[], status = 200): Response {
  const body = events.map((e) => `${e.event ? `event: ${e.event}\n` : ''}data: ${JSON.stringify(e.data)}\n\n`).join('');
  return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
}

function json(status: number, data: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A fetch that answers each request with the next scripted response and records the request bodies. */
function scripted(responses: Array<Response | (() => Response)>) {
  const bodies: Array<Record<string, unknown>> = [];
  const urls: string[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input instanceof Request ? input.url : input));
    const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
    bodies.push(raw ? JSON.parse(String(raw)) : {});
    const next = responses.shift();
    if (!next) throw new Error('No scripted response left');
    return typeof next === 'function' ? next() : next;
  }) as typeof globalThis.fetch;
  return { fetch, bodies, urls };
}

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

const doneOf = (events: ModelEvent[]) => events.find((e) => e.type === 'done') as Extract<ModelEvent, { type: 'done' }> | undefined;
const errorOf = (events: ModelEvent[]) => events.find((e) => e.type === 'error') as Extract<ModelEvent, { type: 'error' }> | undefined;

const TOOLS: ToolDefinition[] = [
  { name: 'read_page', description: 'Read a page', parameters: { type: 'object', properties: { pageId: { type: 'string' } }, required: ['pageId'] } },
  { name: 'read_project', description: 'Read the project', parameters: { type: 'object', properties: {} } }
];

const request = (over: Partial<CanonicalModelRequest> = {}): CanonicalModelRequest => ({
  model: 'gpt-6.2-sol',
  system: 'You edit websites.',
  items: [{ kind: 'user', text: 'Add a page' }],
  tools: TOOLS,
  maxOutputTokens: 32000,
  ...over
});

// ---------------------------------------------------------------------------
// OpenAI Responses API
// ---------------------------------------------------------------------------

const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc-abc' };
const fnCall = (callId: string, name: string, args: string, status = 'completed') => ({ type: 'function_call', id: `fc_${callId}`, call_id: callId, name, arguments: args, status });
const message = (text: string) => ({ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
const usage = { input_tokens: 120, output_tokens: 30, total_tokens: 150 };

function openaiTurn(output: unknown[], opts: { text?: string; incomplete?: string } = {}): Response {
  const events: Sse[] = [{ event: 'response.created', data: { type: 'response.created', response: { id: 'resp_1', status: 'in_progress', output: [] } } }];
  if (opts.text) for (const delta of opts.text.match(/[\s\S]{1,6}/g) ?? []) events.push({ event: 'response.output_text.delta', data: { type: 'response.output_text.delta', delta, item_id: 'msg_1', output_index: 0, content_index: 0 } });
  if (opts.incomplete)
    events.push({ event: 'response.incomplete', data: { type: 'response.incomplete', response: { id: 'resp_1', status: 'incomplete', incomplete_details: { reason: opts.incomplete }, output, usage } } });
  else events.push({ event: 'response.completed', data: { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output, usage } } });
  return sse(events);
}

describe('OpenAI adapter (Responses API wire format)', () => {
  it('runs a multi-turn tool loop, replaying encrypted reasoning and tool results', async () => {
    const { fetch, bodies, urls } = scripted([openaiTurn([reasoning, fnCall('call_1', 'read_project', '{}')]), openaiTurn([message('Added the page.')], { text: 'Added the page.' })]);
    const adapter = new OpenAIAdapter('sk-test', 'gpt-6.2-sol', { fetch });

    const first = await collect(adapter.streamTurn(request(), new AbortController().signal));
    const d1 = doneOf(first)!;
    expect(d1.stopReason).toBe('tool_use');
    expect(d1.toolCalls).toEqual([{ id: 'call_1', name: 'read_project', arguments: '{}' }]);
    expect(d1.usage).toEqual({ inputTokens: 120, outputTokens: 30 });
    expect(urls[0]).toMatch(/\/responses$/);
    expect(bodies[0]).toMatchObject({ model: 'gpt-6.2-sol', instructions: 'You edit websites.', store: false, stream: true, parallel_tool_calls: true, include: ['reasoning.encrypted_content'], max_output_tokens: 32000 });
    expect((bodies[0].tools as unknown[]).length).toBe(2);

    const second = await collect(
      adapter.streamTurn(
        request({
          items: [
            { kind: 'user', text: 'Add a page' },
            { kind: 'assistant', text: '', toolCalls: d1.toolCalls, providerData: d1.providerData },
            { kind: 'tool_result', callId: 'call_1', name: 'read_project', content: '{"revision":0}' }
          ]
        }),
        new AbortController().signal
      )
    );
    expect(second.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('Added the page.');
    expect(doneOf(second)).toMatchObject({ stopReason: 'end', text: 'Added the page.', toolCalls: [] });
    const input = bodies[1].input as Array<Record<string, unknown>>;
    expect(input.map((i) => i.type ?? i.role)).toEqual(['user', 'reasoning', 'function_call', 'function_call_output']);
    expect(input[1].encrypted_content).toBe('enc-abc');
    expect(input[3]).toEqual({ type: 'function_call_output', call_id: 'call_1', output: '{"revision":0}' });
  });

  it('returns every call of a parallel tool turn, in order', async () => {
    const { fetch } = scripted([openaiTurn([reasoning, fnCall('a', 'read_page', '{"pageId":"pg_1"}'), fnCall('b', 'read_page', '{"pageId":"pg_2"}'), fnCall('c', 'read_project', '{}')])]);
    const events = await collect(new OpenAIAdapter('sk-test', 'gpt-6.2-sol', { fetch }).streamTurn(request(), new AbortController().signal));
    const expected = [
      { id: 'a', name: 'read_page', arguments: '{"pageId":"pg_1"}' },
      { id: 'b', name: 'read_page', arguments: '{"pageId":"pg_2"}' },
      { id: 'c', name: 'read_project', arguments: '{}' }
    ];
    expect(events.filter((e) => e.type === 'tool_call').map((e) => (e as { call: unknown }).call)).toEqual(expected);
    expect(doneOf(events)!.toolCalls).toEqual(expected);
  });

  it('drops a half-written function call and its provider data when the output budget runs out', async () => {
    const { fetch } = scripted([
      openaiTurn([reasoning, message('Working on it.'), fnCall('ok', 'read_project', '{}'), fnCall('big', 'apply_operations', '{"expectedRevision":3,"operations":[{"type":"node.ins', 'incomplete')], { text: 'Working on it.', incomplete: 'max_output_tokens' })
    ]);
    const events = await collect(new OpenAIAdapter('sk-test', 'gpt-6.2-sol', { fetch }).streamTurn(request(), new AbortController().signal));
    const done = doneOf(events)!;
    expect(done.stopReason).toBe('max_tokens');
    // Even the finished sibling call is held back: the whole turn is retried in smaller steps.
    expect(done.toolCalls).toEqual([]);
    expect(done.text).toBe('Working on it.');
    expect(done.usage).toEqual({ inputTokens: 120, outputTokens: 30 });
    expect(done.providerData).toBeUndefined();
    expect(events.some((e) => e.type === 'tool_call')).toBe(false);
  });

  it('classifies failures reported inside a 200 stream so the caller can retry them', async () => {
    const failed = sse([{ event: 'response.failed', data: { type: 'response.failed', response: { id: 'r', status: 'failed', output: [], error: { code: 'rate_limit_exceeded', message: 'Rate limit reached' } } } }]);
    const serverError = sse([{ event: 'response.failed', data: { type: 'response.failed', response: { id: 'r', status: 'failed', output: [], error: { code: 'server_error', message: 'Something went wrong' } } } }]);
    const errorEvent = sse([{ event: 'error', data: { type: 'error', code: 'rate_limit_exceeded', message: 'Too many tokens per minute', param: null } }]);
    // An unnamed frame reaches the adapter's own error arm rather than the SDK's.
    const unnamed = sse([{ data: { type: 'error', code: 'server_error', message: 'Upstream failed', param: null, sequence_number: 1 } }]);
    const quota = sse([{ event: 'response.failed', data: { type: 'response.failed', response: { id: 'r', status: 'failed', output: [], error: { code: null, type: 'insufficient_quota', message: 'You exceeded your current quota' } } } }]);
    const permanent = sse([{ event: 'response.failed', data: { type: 'response.failed', response: { id: 'r', status: 'failed', output: [], error: { code: 'invalid_prompt', message: 'Your prompt was flagged.' } } } }]);
    const { fetch } = scripted([failed, serverError, errorEvent, unnamed, quota, permanent]);
    const adapter = new OpenAIAdapter('sk-test', 'gpt-6.2-sol', { fetch });
    const next = async () => errorOf(await collect(adapter.streamTurn(request(), new AbortController().signal)));
    expect((await next())?.code).toBe('rate_limit');
    expect((await next())?.code).toBe('overloaded');
    expect((await next())?.code).toBe('rate_limit');
    expect((await next())?.code).toBe('overloaded');
    expect(await next()).toMatchObject({ code: 'invalid_request', message: expect.stringMatching(/quota/) });
    expect(await next()).toMatchObject({ code: 'invalid_request', message: 'Your prompt was flagged.' });
  });

  it('classifies HTTP errors, including retry-after and exhausted quota', async () => {
    const { fetch } = scripted([
      json(429, { error: { message: 'Rate limit', type: 'requests', code: 'rate_limit_exceeded' } }, { 'retry-after': '2' }),
      json(429, { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: null } }),
      json(401, { error: { message: 'Incorrect API key provided: sk-abcdefghijkl', code: 'invalid_api_key' } })
    ]);
    const adapter = new OpenAIAdapter('sk-test', 'gpt-6.2-sol', { fetch });
    expect(errorOf(await collect(adapter.streamTurn(request(), new AbortController().signal)))).toMatchObject({ code: 'rate_limit', retryAfterMs: 2000 });
    expect(errorOf(await collect(adapter.streamTurn(request(), new AbortController().signal)))).toMatchObject({ code: 'invalid_request', message: expect.stringMatching(/quota/) });
    const auth = errorOf(await collect(adapter.streamTurn(request(), new AbortController().signal)))!;
    expect(auth.code).toBe('auth');
    expect(auth.message).not.toContain('sk-abcdefghijkl');
  });

  it('sends no tool options when there are no tools (the code fixer)', async () => {
    const { fetch, bodies } = scripted([openaiTurn([message('Fixed it.')], { text: 'Fixed it.' })]);
    const events = await collect(new OpenAIAdapter('sk-test', 'gpt-6.2-sol', { fetch }).streamTurn(request({ tools: [] }), new AbortController().signal));
    expect(doneOf(events)?.stopReason).toBe('end');
    expect(bodies[0]).not.toHaveProperty('tools');
    expect(bodies[0]).not.toHaveProperty('parallel_tool_calls');
  });

  it('retries without encrypted reasoning when a custom model rejects it, and stops replaying reasoning items', async () => {
    const { fetch, bodies } = scripted([
      openaiTurn([message('Hi.')], { text: 'Hi.' }),
      json(400, { error: { message: "Encrypted content is not supported with this model. Remove 'reasoning.encrypted_content' from include.", type: 'invalid_request_error', param: 'include', code: null } }),
      openaiTurn([fnCall('x', 'read_project', '{}')]),
      openaiTurn([message('Done.')], { text: 'Done.' })
    ]);
    const adapter = new OpenAIAdapter('sk-test', 'gpt-4.1', { fetch });
    // While encrypted reasoning is on, a reasoning item without its encrypted content still cannot be replayed.
    await collect(adapter.streamTurn(request({ model: 'gpt-4.1', items: [{ kind: 'user', text: 'Hi' }, { kind: 'assistant', text: '', toolCalls: [], providerData: [{ type: 'reasoning', id: 'rs_plain', summary: [] }, reasoning, message('Hello')] }, { kind: 'user', text: 'Again' }] }), new AbortController().signal));
    const replayed = (bodies.shift()!.input as Array<{ type?: string; id?: string }>).filter((i) => i.type === 'reasoning').map((i) => i.id);
    expect(replayed).toEqual(['rs_1']);
    const d1 = doneOf(await collect(adapter.streamTurn(request({ model: 'gpt-4.1' }), new AbortController().signal)))!;
    expect(d1.toolCalls).toHaveLength(1);
    expect(bodies[0]).toHaveProperty('include');
    expect(bodies[1]).not.toHaveProperty('include');
    await collect(
      adapter.streamTurn(
        request({ model: 'gpt-4.1', items: [{ kind: 'user', text: 'Hi' }, { kind: 'assistant', text: '', toolCalls: d1.toolCalls, providerData: [reasoning, ...(d1.providerData as unknown[])] }, { kind: 'tool_result', callId: 'x', name: 'read_project', content: '{}' }] }),
        new AbortController().signal
      )
    );
    expect((bodies[2].input as Array<{ type?: string }>).some((i) => i.type === 'reasoning')).toBe(false);
    expect(bodies[2]).not.toHaveProperty('include');
  });

  it('lowers the output budget when a custom model rejects it', async () => {
    const { fetch, bodies } = scripted([json(400, { error: { message: 'max_output_tokens is too large: 32000. This model supports at most 16384 completion tokens.', type: 'invalid_request_error', param: 'max_output_tokens' } }), openaiTurn([message('Hi')], { text: 'Hi' })]);
    const adapter = new OpenAIAdapter('sk-test', 'gpt-4o', { fetch });
    expect(adapter.capabilities().maxOutputTokens).toBe(32000);
    const events = await collect(adapter.streamTurn(request({ model: 'gpt-4o' }), new AbortController().signal));
    expect(doneOf(events)?.stopReason).toBe('end');
    // The ceiling the API reports is used, and kept for later requests.
    expect(bodies[1].max_output_tokens).toBe(16384);
    expect(adapter.capabilities().maxOutputTokens).toBe(16384);
  });

  it('retries without parallel_tool_calls when a model rejects it, keeping the tools', async () => {
    const { fetch, bodies } = scripted([json(400, { error: { message: "Unsupported parameter: 'parallel_tool_calls' is not supported with this model.", type: 'invalid_request_error', param: 'parallel_tool_calls' } }), openaiTurn([fnCall('x', 'read_project', '{}')])]);
    const adapter = new OpenAIAdapter('sk-test', 'o-old', { fetch });
    const events = await collect(adapter.streamTurn(request({ model: 'o-old' }), new AbortController().signal));
    expect(doneOf(events)?.toolCalls).toHaveLength(1);
    expect(bodies[1]).not.toHaveProperty('parallel_tool_calls');
    expect((bodies[1].tools as unknown[]).length).toBe(2);
    expect(adapter.capabilities().parallelToolCalls).toBe(false);
  });

  it('does not treat an unrelated 400 as a feature to drop', async () => {
    const { fetch, bodies } = scripted([json(400, { error: { message: 'input[4]: reasoning item is missing its required following item.', type: 'invalid_request_error', param: 'input' } })]);
    const events = await collect(new OpenAIAdapter('sk-test', 'gpt-6.2-sol', { fetch }).streamTurn(request(), new AbortController().signal));
    expect(errorOf(events)?.code).toBe('invalid_request');
    expect(bodies).toHaveLength(1);
  });

  it('reports a cancelled request as cancelled', async () => {
    const abort = new AbortController();
    const fetch = (async () => {
      abort.abort();
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      throw err;
    }) as typeof globalThis.fetch;
    const events = await collect(new OpenAIAdapter('sk-test', 'gpt-6.2-sol', { fetch }).streamTurn(request(), abort.signal));
    expect(errorOf(events)?.code).toBe('cancelled');
  });

  it('tests a project key that cannot read model metadata with a minimal request instead', async () => {
    const { fetch, bodies, urls } = scripted([
      json(403, { error: { message: 'You have insufficient permissions for this operation. Missing scopes: api.model.read.', type: 'invalid_request_error' } }),
      json(200, { id: 'resp_p', object: 'response', status: 'incomplete', output: [], usage })
    ]);
    const r = await testOpenAI('sk-proj-test', 'gpt-6.2-sol', { fetch });
    expect(r.ok).toBe(true);
    expect(urls[0]).toMatch(/\/models\/gpt-6\.2-sol$/);
    expect(urls[1]).toMatch(/\/responses$/);
    expect(bodies[1]).toMatchObject({ model: 'gpt-6.2-sol', store: false, max_output_tokens: 16 });
  });

  it('reports a failed ping and does not ping after other lookup failures', async () => {
    const failedPing = scripted([json(403, { error: { message: 'Missing scopes: api.model.read.' } }), json(200, { id: 'r', object: 'response', status: 'failed', output: [], error: { code: 'server_error', message: 'The model failed.' } })]);
    expect(await testOpenAI('sk-proj-test', 'gpt-6.2-sol', { fetch: failedPing.fetch })).toMatchObject({ ok: false, message: expect.stringMatching(/failed/) });
    const missing = scripted([json(404, { error: { message: 'The model does not exist', code: 'model_not_found' } })]);
    expect(await testOpenAI('sk-test', 'gpt-nope', { fetch: missing.fetch })).toMatchObject({ ok: false, message: expect.stringMatching(/not available/) });
    expect(missing.bodies).toHaveLength(1);
  });

  it('runs the code fixer over the wire without tools', async () => {
    const fixed = '<script>\n  let { heading = "Hi" } = $props();\n</script>\n\n<h2>{heading}</h2>\n';
    const reply = `Replaced export let with $props.\n\n\`\`\`svelte\n${fixed}\`\`\``;
    const { fetch, bodies } = scripted([openaiTurn([message(reply)], { text: reply })]);
    const check = async (src: string) => (src.includes('export let') ? [{ severity: 'error', message: 'Use $props instead of export let.' }] : []);
    const r = await fixComponentSource(new OpenAIAdapter('sk-test', 'gpt-6.2-sol', { fetch }), 'gpt-6.2-sol', '<script>\n  export let heading = "Hi";\n</script>\n\n<h2>{heading}</h2>\n', check, new AbortController().signal);
    expect(r).toMatchObject({ ok: true, source: fixed, attempts: 1 });
    expect(bodies[0]).not.toHaveProperty('tools');
    expect(bodies[0]).not.toHaveProperty('parallel_tool_calls');
  });
});

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

function anthropicTurn(blocks: Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; json: string }>, stopReason: string): Response {
  const events: Sse[] = [
    { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 90, output_tokens: 1 } } } }
  ];
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      events.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } });
      events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } } });
    } else {
      events.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } } });
      if (b.json) events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: b.json } } });
    }
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
  });
  events.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 42 } } });
  events.push({ event: 'message_stop', data: { type: 'message_stop' } });
  return sse(events);
}

describe('Anthropic adapter (Messages API wire format)', () => {
  it('runs a multi-turn tool loop with parallel tool calls and grouped tool results', async () => {
    const { fetch, bodies, urls } = scripted([
      anthropicTurn(
        [
          { type: 'text', text: 'Reading both pages.' },
          { type: 'tool_use', id: 'toolu_1', name: 'read_page', json: '{"pageId":"pg_1"}' },
          { type: 'tool_use', id: 'toolu_2', name: 'read_page', json: '{"pageId":"pg_2"}' }
        ],
        'tool_use'
      ),
      anthropicTurn([{ type: 'text', text: 'Both pages look fine.' }], 'end_turn')
    ]);
    const adapter = new AnthropicAdapter('sk-ant-test', 'claude-sonnet-5-5', { fetch });
    expect(adapter.capabilities().parallelToolCalls).toBe(true);
    const first = await collect(adapter.streamTurn(request({ model: 'claude-sonnet-5-5' }), new AbortController().signal));
    expect(first.map((e) => e.type)).toEqual(['text', 'tool_call', 'tool_call', 'done']);
    const d1 = doneOf(first)!;
    expect(d1.stopReason).toBe('tool_use');
    expect(d1.text).toBe('Reading both pages.');
    expect(d1.toolCalls).toEqual([
      { id: 'toolu_1', name: 'read_page', arguments: '{"pageId":"pg_1"}' },
      { id: 'toolu_2', name: 'read_page', arguments: '{"pageId":"pg_2"}' }
    ]);
    expect(d1.usage).toEqual({ inputTokens: 90, outputTokens: 42 });
    expect(urls[0]).toMatch(/\/v1\/messages$/);
    expect(bodies[0]).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 32000, system: 'You edit websites.', stream: true });
    expect((bodies[0].tools as unknown[]).length).toBe(2);

    const second = await collect(
      adapter.streamTurn(
        request({
          model: 'claude-sonnet-5-5',
          items: [
            { kind: 'user', text: 'Check the pages' },
            { kind: 'assistant', text: d1.text, toolCalls: d1.toolCalls, providerData: d1.providerData },
            { kind: 'tool_result', callId: 'toolu_1', name: 'read_page', content: '{"title":"Home"}' },
            { kind: 'tool_result', callId: 'toolu_2', name: 'read_page', content: 'No page', isError: true }
          ]
        }),
        new AbortController().signal
      )
    );
    expect(doneOf(second)).toMatchObject({ stopReason: 'end', text: 'Both pages look fine.' });
    const messages = bodies[1].messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"title":"Home"}' },
      { type: 'tool_result', tool_use_id: 'toolu_2', content: 'No page', is_error: true }
    ]);
  });

  it('drops a tool call cut off by the output budget', async () => {
    const { fetch } = scripted([anthropicTurn([{ type: 'tool_use', id: 'toolu_big', name: 'apply_operations', json: '{"expectedRevision": 2, "operations": [{"type": "node' }], 'max_tokens')]);
    const events = await collect(new AnthropicAdapter('sk-ant-test', 'claude-sonnet-5-5', { fetch }).streamTurn(request({ model: 'claude-sonnet-5-5' }), new AbortController().signal));
    const done = doneOf(events)!;
    expect(done.stopReason).toBe('max_tokens');
    expect(done.toolCalls).toEqual([]);
    expect(done.providerData).toBeUndefined();
    expect(events.some((e) => e.type === 'tool_call')).toBe(false);
  });

  it('classifies overload and rate-limit errors, in the stream and over HTTP', async () => {
    const overloaded = sse([
      { event: 'message_start', data: { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } } },
      { event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } }
    ]);
    const invalid = sse([{ event: 'error', data: { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: bad request' } } }]);
    const { fetch, bodies } = scripted([overloaded, json(429, { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } }, { 'retry-after': '3' }), invalid]);
    const adapter = new AnthropicAdapter('sk-ant-test', 'claude-sonnet-5-5', { fetch });
    expect(errorOf(await collect(adapter.streamTurn(request({ model: 'claude-sonnet-5-5' }), new AbortController().signal)))?.code).toBe('overloaded');
    expect(errorOf(await collect(adapter.streamTurn(request({ model: 'claude-sonnet-5-5' }), new AbortController().signal)))).toMatchObject({ code: 'rate_limit', retryAfterMs: 3000 });
    // A permanent error inside the stream is reported once, not retried or mistaken for an overload.
    expect(errorOf(await collect(adapter.streamTurn(request({ model: 'claude-sonnet-5-5' }), new AbortController().signal)))?.code).toBe('invalid_request');
    expect(bodies).toHaveLength(3);
  });

  it('sends no tools when there are none, and lowers a rejected output budget', async () => {
    const { fetch, bodies } = scripted([
      json(400, { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: 32000 > 8192, which is the maximum allowed number of output tokens for claude-old' } }),
      anthropicTurn([{ type: 'text', text: 'Fixed.' }], 'end_turn')
    ]);
    const adapter = new AnthropicAdapter('sk-ant-test', 'claude-old', { fetch });
    const events = await collect(adapter.streamTurn(request({ model: 'claude-old', tools: [] }), new AbortController().signal));
    expect(doneOf(events)).toMatchObject({ stopReason: 'end', text: 'Fixed.' });
    expect(bodies[0]).not.toHaveProperty('tools');
    expect(bodies[1].max_tokens).toBe(8192);
    expect(adapter.capabilities().maxOutputTokens).toBe(8192);
  });
});

describe('cloud adapters and the environment', () => {
  let mock: MockOpenAIServer | null = null;
  afterEach(async () => {
    vi.unstubAllEnvs();
    await mock?.stop();
    mock = null;
  });

  /**
   * Answers requests to the provider's own API with the next scripted response, and passes a request for the mock
   * server on to it, as a request the environment redirected would go. Nothing else leaves the test.
   */
  function official(origin: string, responses: Array<() => Response>) {
    const seen: Array<{ url: string; headers: Headers }> = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      seen.push({ url, headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)) });
      if (mock && new URL(url).origin === new URL(mock.baseURL).origin) return globalThis.fetch(input, { ...init, redirect: 'error' });
      if (!url.startsWith(origin)) throw new Error(`Unexpected request to ${url}`);
      const next = responses.shift();
      if (!next) throw new Error('No scripted response left');
      return next();
    }) as typeof globalThis.fetch;
    return { fetch, seen };
  }

  it('sends a cloud run and a connection test to the provider, never to a base URL set in the environment', async () => {
    mock = await new MockOpenAIServer().start();
    vi.stubEnv('OPENAI_BASE_URL', mock.baseURL);
    vi.stubEnv('OPENAI_ORG_ID', 'org-from-env');
    vi.stubEnv('OPENAI_PROJECT_ID', 'proj-from-env');
    vi.stubEnv('ANTHROPIC_BASE_URL', mock.baseURL.replace(/\/v1$/, ''));
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'token-from-env');

    const openai = official('https://api.openai.com/v1/', [() => openaiTurn([message('Done.')], { text: 'Done.' }), () => json(200, { id: 'gpt-6.2-sol', object: 'model' })]);
    expect(doneOf(await collect(new OpenAIAdapter('sk-test', 'gpt-6.2-sol', { fetch: openai.fetch }).streamTurn(request(), new AbortController().signal)))?.text).toBe('Done.');
    expect((await testOpenAI('sk-test', 'gpt-6.2-sol', { fetch: openai.fetch })).ok).toBe(true);

    const anthropic = official('https://api.anthropic.com/v1/', [() => anthropicTurn([{ type: 'text', text: 'Done.' }], 'end_turn'), () => json(200, { id: 'claude-sonnet-5-5', type: 'model' })]);
    expect(doneOf(await collect(new AnthropicAdapter('sk-ant-test', 'claude-sonnet-5-5', { fetch: anthropic.fetch }).streamTurn(request({ model: 'claude-sonnet-5-5' }), new AbortController().signal)))?.text).toBe('Done.');
    expect((await testAnthropic('sk-ant-test', 'claude-sonnet-5-5', { fetch: anthropic.fetch })).ok).toBe(true);

    expect(mock.requests).toEqual([]);
    expect(openai.seen.map((r) => r.url)).toEqual(['https://api.openai.com/v1/responses', 'https://api.openai.com/v1/models/gpt-6.2-sol']);
    expect(anthropic.seen.map((r) => r.url)).toEqual(['https://api.anthropic.com/v1/messages', 'https://api.anthropic.com/v1/models/claude-sonnet-5-5']);
    // Nothing else from the environment rides along: no organization or project, and only the app's own key.
    for (const r of openai.seen) {
      expect(r.headers.get('openai-organization')).toBeNull();
      expect(r.headers.get('openai-project')).toBeNull();
      expect(r.headers.get('authorization')).toBe('Bearer sk-test');
    }
    // This SDK version sends the key as a bearer token; the token from the environment never replaces it.
    for (const r of anthropic.seen) {
      expect(r.headers.get('authorization')).toBe('Bearer sk-ant-test');
      expect(r.headers.get('x-api-key')).toBeNull();
    }
    expect(JSON.stringify(anthropic.seen.map((r) => [...r.headers]))).not.toContain('token-from-env');
  });
});
