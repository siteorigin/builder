/**
 * A blog asked of the assistant is the app's own blog (#1423): the ready-made "posts" collection, its posts written as
 * entries, never a /blog/ page with dated article pages under it. A small model is offered the tool that makes it, a
 * run limited to one page asks to widen first, and a question says where the author writes a post.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatContext } from '@shared/api';
import type { ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState, type StarterId } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { Orchestrator } from '@agent/orchestrator';
import type { AgentModelAdapter, CanonicalModelRequest, ModelEvent } from '@agent/types';
import { asksForCollection, toolsForRun } from '@agent/tools';
import { ProjectSession } from '../../src/main/project/session';

const REQUEST = 'please add a blog to my site with two short posts, one about glazes and one about kiln firing';

class FakeAdapter implements AgentModelAdapter {
  requests: CanonicalModelRequest[] = [];
  constructor(
    private turns: Array<(req: CanonicalModelRequest) => ModelEvent[]> = [],
    private toolCalling: 'native' | 'constrained-json' = 'native'
  ) {}
  capabilities() {
    return { toolCalling: this.toolCalling, streaming: true, strictSchemas: false, parallelToolCalls: true, contextWindowTokens: 100000, maxOutputTokens: 32000 } as ReturnType<AgentModelAdapter['capabilities']>;
  }
  async *streamTurn(req: CanonicalModelRequest): AsyncIterable<ModelEvent> {
    this.requests.push(structuredClone(req));
    const turn = this.turns.shift();
    for (const ev of turn ? turn(req) : [{ type: 'done' as const, stopReason: 'end' as const, text: 'Done.', toolCalls: [] }]) yield ev;
  }
}
const call = (id: string, name: string, args: unknown): ModelEvent => ({ type: 'done', stopReason: 'tool_use', text: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
const lastResult = (req: CanonicalModelRequest) => JSON.parse((req.items.at(-1) as { content?: string }).content ?? '{}') as Record<string, unknown>;

const blank = () => structuredClone(createStarterState('blank' as StarterId, 'Clay Studio', false));
const withPosts = (s: ProjectState) => applyOperations(s, [{ type: 'collection.create', collectionId: 'posts' } as EditOperation]).state;

const dirs: string[] = [];
const sessions: ProjectSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close().catch(() => undefined);
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

/** Sends one request to a project and returns the model's adapter, with every request it was sent, and the session. */
async function run(start: ProjectState, text: string, ctx: Partial<ChatContext>, opts: { turns?: Array<(req: CanonicalModelRequest) => ModelEvent[]>; toolCalling?: 'constrained-json' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'so-blog-'));
  dirs.push(dir);
  const session = await ProjectSession.create(dir, start);
  sessions.push(session);
  const adapter = new FakeAdapter(opts.turns, opts.toolCalling);
  let busy = false;
  const orch = new Orchestrator({
    session: () => session,
    adapter: async () => ({ adapter, model: 'fake', provider: 'openai' }),
    emit: () => {},
    compileAll: async () => [],
    inspectLayout: async () => ({ issues: [] }),
    onBusyChange: (b) => (busy = b)
  });
  const r = await orch.send(text, { pageId: session.state.site.homePageId, pageTitle: 'Home', selection: null, selectionLabel: null, viewport: 1280, ...ctx });
  expect(r.ok).toBe(true);
  while (orch.busy || busy) await new Promise((res) => setTimeout(res, 10));
  return { adapter, session };
}

const toolText = (req: CanonicalModelRequest, name: string) => {
  const t = req.tools.find((x) => x.name === name);
  return t ? `${t.description}\n${JSON.stringify(t.parameters)}` : '';
};

describe('a request for a blog (#1423)', () => {
  it('counts as a request for a collection, so a small model is offered the tool that makes the blog', () => {
    for (const text of [REQUEST, 'Start a blog', 'Add two blog posts about glazes', 'Write three posts for the news section']) expect(asksForCollection(text), text).toBe(true);
    for (const text of ['Make the hero teal', 'Add our post office box to the footer', 'Add a postcode field to the contact form']) expect(asksForCollection(text), text).toBe(false);
    const small = { toolCalling: 'constrained-json' as const, contextWindowTokens: 8000 };
    const tools = (collectionRequest: boolean) => toolsForRun({ state: blank(), selection: null, capabilities: small, codeEnabled: false, definitionOps: false, collectionRequest }).tools.map((t) => t.name);
    expect(tools(asksForCollection(REQUEST))).toContain('define_collection');
    expect(tools(false)).not.toContain('define_collection');
  });

  it.each([
    ['a native model', undefined],
    ['a grammar-constrained model', 'constrained-json' as const]
  ])('tells %s on the whole site that a blog is the posts collection, never article pages', async (_, toolCalling) => {
    const { adapter } = await run(blank(), REQUEST, { scope: 'site' }, { toolCalling });
    const req = adapter.requests[0];
    expect(req.tools.map((t) => t.name)).toContain('define_collection');
    // One instruction line names the posts collection, how define_collection makes it, and that a blog is never pages.
    expect(req.system).toMatch(/^(?=[^\n]*\bblog\b)(?=[^\n]*define_collection)(?=[^\n]*"posts")(?=[^\n]*never[^\n]*pages)[^\n]*$/im);
    expect(toolText(req, 'define_collection')).toMatch(/blog[^\n]*"posts"|"posts"[^\n]*blog/i);
    // The page tool's dated articles say they are not a blog's posts.
    expect(toolText(req, 'upsert_page_with_sections')).toMatch(/blog posts? (are|is) (entries|an entry)/i);
  });

  it('makes the posts collection at /blog/ and writes each post as a draft entry, with no page added', async () => {
    const start = blank();
    const results: Record<string, unknown>[] = [];
    const { adapter, session } = await run(start, REQUEST, { scope: 'site' }, {
      turns: [
        () => [call('c1', 'define_collection', { action: 'create', collectionId: 'posts' })],
        (req) => (results.push(lastResult(req)), [call('c2', 'upsert_collection_entry', { collectionId: 'posts', title: 'What Glaze Does to Clay', body: ['Glaze is glass.'] })]),
        (req) => (results.push(lastResult(req)), [call('c3', 'upsert_collection_entry', { collectionId: 'posts', title: 'What Happens in a Kiln Firing', body: ['Heat changes clay.'] })]),
        (req) => (results.push(lastResult(req)), [{ type: 'done', stopReason: 'end', text: 'Started the blog with two draft posts.', toolCalls: [] }])
      ]
    });
    expect(results[0], JSON.stringify(results[0])).toMatchObject({ ok: true, collectionId: 'posts', route: '/blog/' });
    for (const r of results.slice(1)) expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    expect(adapter.requests).toHaveLength(4);
    // Once the blog exists, the next step writes its posts and is told how.
    expect(JSON.stringify(adapter.requests[1].tools.find((t) => t.name === 'upsert_collection_entry')!.parameters)).toContain('"posts"');
    expect(adapter.requests[1].system).toMatch(/^(?=[^\n]*\bblog\b)(?=[^\n]*upsert_collection_entry)(?=[^\n]*never[^\n]*pages)[^\n]*$/im);
    const posts = session.state.collections.posts;
    expect(posts.settings.route).toBe('/blog/');
    expect(Object.keys(posts.settings.taxonomies).sort()).toEqual(['categories', 'tags']);
    expect(Object.values(posts.entries).map((e) => [e.title, e.draft]).sort()).toEqual([
      ['What Glaze Does to Clay', true],
      ['What Happens in a Kiln Firing', true]
    ]);
    expect(Object.keys(session.state.pages)).toEqual(Object.keys(start.pages));
  });

  it.each([
    ['a native model', undefined],
    ['a grammar-constrained model', 'constrained-json' as const]
  ])('has %s limited to one page ask to widen before it starts a blog', async (_, toolCalling) => {
    for (const start of [blank(), withPosts(blank())]) {
      const { adapter } = await run(start, REQUEST, { scope: 'page' }, { toolCalling });
      const req = adapter.requests[0];
      expect(req.tools.map((t) => t.name)).toContain('request_clarification');
      expect(req.system).toMatch(/^(?=[^\n]*\bblog\b)(?=[^\n]*"posts")(?=[^\n]*request_clarification \(widenScope: true\))(?=[^\n]*never[^\n]*pages)[^\n]*$/im);
    }
  });

  it.each([
    ['a native model', undefined],
    ['a grammar-constrained model', 'constrained-json' as const]
  ])('has %s answer a question with where the author writes a blog post', async (_, toolCalling) => {
    const question = 'Where do I go to write a new blog post myself?';
    const none = (await run(blank(), question, { mode: 'ask' }, { toolCalling })).adapter.requests[0].system;
    expect(none).toMatch(/^[^\n]*no blog yet[^\n]*Content[^\n]*Blog posts[^\n]*$/im);
    const some = (await run(withPosts(blank()), question, { mode: 'ask' }, { toolCalling })).adapter.requests[0].system;
    expect(some).toMatch(/^[^\n]*blog post[^\n]*Content[^\n]*New post[^\n]*$/im);
    expect(some).not.toMatch(/no blog yet/);
    for (const text of [none, some]) expect(text).toMatch(/never[^\n]*(Article starter|pages)/i);
  });
});
