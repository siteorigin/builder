/**
 * The built-in kinds of source (#678), each read from a server of the test's own, as the sync worker reads it: a REST
 * API page by page in each way it can be paged, GraphQL, Contentful's Delivery API with its linked assets and rich
 * text, Sanity, Strapi 4 and 5, and WordPress; each record put in shape by the source's mapping over the kind's own
 * reading. Credentials go only where the settings say, and only to the source's own server: a next page, a redirect
 * or a converter's request to another server is refused before it is asked.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { runSync } from '../../src/main/sources/run';
import { ADAPTERS } from '../../src/main/sources/adapters';
import { contentfulRichText, markdownRichText, type LinkRead } from '../../src/main/sources/richtext';
import type { SyncReply, SyncRequest } from '../../src/main/sources/protocol';
import { graphqlReadProblem, sourceDocProblem, sourceSecretNames } from '@shared/sources';
import { pathSteps, readPath } from '@shared/source-paths';

const SECRET = 'tok-5d4c3b2a1f0e9d8c';
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

interface Seen {
  method: string;
  url: URL;
  headers: IncomingMessage['headers'];
  body: string;
}

/** A server of the test's own on this computer, answering with `answer`; every request it was sent is in `seen`. */
async function server(answer: (req: Seen, res: ServerResponse, origin: string) => void) {
  const seen: Seen[] = [];
  let origin = '';
  const s = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const r = { method: req.method ?? 'GET', url: new URL(req.url ?? '/', origin), headers: req.headers, body };
      seen.push(r);
      answer(r, res, origin);
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const addr = s.address();
  origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  return { origin, seen };
}

const send = (res: ServerResponse, body: unknown, headers: Record<string, string> = {}, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

/** Run one sync (or sample) the way the worker does, with pictures fetched by the test. */
async function run(req: Partial<SyncRequest> & Pick<SyncRequest, 'adapter' | 'config'>, env: { contentful?: string; sanity?: string } = {}): Promise<SyncReply> {
  const fetched: string[] = [];
  const reply = await runSync({ id: 1, secrets: {}, known: {}, ...req }, { adapters: ADAPTERS, env: { endpoints: env }, fetchImage: async (url) => (fetched.push(url), { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' }) });
  return Object.assign(reply, { fetched });
}

const people = (n: number, from = 1) =>
  Array.from({ length: n }, (_, i) => ({ id: from + i, fields: { fullName: `Person ${from + i}`, jobTitle: 'Maker', avatar: { url: `https://cdn.example/p${from + i}.png` } } }));

describe('a REST source', () => {
  const mapping = { title: 'fields.fullName', featuredImageUrl: 'fields.avatar.url', values: { role: 'fields.jobTitle' } };

  it('reads every page by number, signs in only as its headers say, and maps each record', async () => {
    const api = await server((req, res) => {
      const page = Number(req.url.searchParams.get('page'));
      send(res, { data: { items: page === 1 ? people(2) : page === 2 ? people(1, 3) : [] } });
    });
    const reply = await run({
      adapter: 'rest',
      config: { url: `${api.origin}/team`, headers: { Authorization: 'Bearer ${secret:team-token}' }, query: { status: 'published' }, itemsPath: 'data.items', pagination: { type: 'page', param: 'page', sizeParam: 'per_page', size: 2 } },
      mapping,
      fields: { role: 'string' },
      secrets: { 'team-token': SECRET }
    });
    expect(reply).toMatchObject({ ok: true });
    if (!reply.ok) return;
    expect(reply.records.map((r) => r.title)).toEqual(['Person 1', 'Person 2', 'Person 3']);
    expect(reply.records[0]).toEqual({ externalId: '1', title: 'Person 1', featuredImage: { $image: { url: 'https://cdn.example/p1.png' } }, values: { role: 'Maker' } });
    // Read until a page brings nothing (a short page may not be the last); each asked with the secret, the query kept.
    expect(api.seen.map((r) => r.url.search)).toEqual(['?status=published&page=1&per_page=2', '?status=published&page=2&per_page=2', '?status=published&page=3&per_page=2']);
    expect(api.seen.every((r) => r.headers.authorization === `Bearer ${SECRET}`)).toBe(true);
    expect(reply.images).toHaveLength(3);
  });

  it('pages by offset, by cursor and by the next page’s address, in the body or a Link header', async () => {
    const all = people(5);
    const byOffset = await server((req, res) => {
      const at = Number(req.url.searchParams.get('offset'));
      send(res, all.slice(at, at + 2));
    });
    const offset = await run({ adapter: 'rest', config: { url: byOffset.origin, pagination: { type: 'offset', param: 'offset', limitParam: 'limit', limit: 2 } }, mapping, fields: { role: 'string' } });
    expect(offset.ok && offset.records.map((r) => r.externalId)).toEqual(['1', '2', '3', '4', '5']);
    expect(byOffset.seen.map((r) => [r.url.searchParams.get('offset'), r.url.searchParams.get('limit')])).toEqual([
      ['0', '2'],
      ['2', '2'],
      ['4', '2'],
      ['5', '2']
    ]);

    const byCursor = await server((req, res) => {
      const c = req.url.searchParams.get('after');
      const at = c ? Number(c) : 0;
      send(res, { items: all.slice(at, at + 2), next: at + 2 < all.length ? String(at + 2) : null });
    });
    const cursor = await run({ adapter: 'rest', config: { url: byCursor.origin, itemsPath: 'items', pagination: { type: 'cursor', param: 'after', cursorPath: 'next' } }, mapping, fields: { role: 'string' } });
    expect(cursor.ok && cursor.records.map((r) => r.externalId)).toEqual(['1', '2', '3', '4', '5']);
    expect(byCursor.seen.map((r) => r.url.searchParams.get('after'))).toEqual([null, '2', '4']);

    const byLink = await server((req, res, origin) => {
      const at = Number(req.url.searchParams.get('at') ?? 0);
      const next = at + 2 < all.length ? `${origin}/?at=${at + 2}` : null;
      // A previous page listed first, and an address with a comma in it.
      send(res, { results: all.slice(at, at + 2), links: { next } }, next && req.url.searchParams.has('header') ? { link: `<${origin}/?at=0&header=1>; rel="prev", <${next}&header=1&tags=a,b>; rel="next"` } : {});
    });
    const link = await run({ adapter: 'rest', config: { url: byLink.origin, itemsPath: 'results', pagination: { type: 'nextLink', path: 'links.next' } }, mapping, fields: { role: 'string' } });
    expect(link.ok && link.records.map((r) => r.externalId)).toEqual(['1', '2', '3', '4', '5']);
    const header = await run({ adapter: 'rest', config: { url: byLink.origin, query: { header: '1' }, itemsPath: 'results', pagination: { type: 'nextLink' } }, mapping, fields: { role: 'string' } });
    expect(header.ok && header.records.map((r) => r.externalId)).toEqual(['1', '2', '3', '4', '5']);
    expect(byLink.seen.at(-1)?.url.searchParams.get('tags')).toBe('a,b');
  });

  it('never sends its credentials to another server: a next page or a redirect elsewhere stops the read before it is asked', async () => {
    const elsewhere = await server((_req, res) => send(res, people(3)));
    const api = await server((req, res) => {
      if (req.url.pathname === '/moved') {
        res.writeHead(302, { location: `${elsewhere.origin}/team` });
        return res.end();
      }
      send(res, { items: people(2), next: `${elsewhere.origin}/team?page=2` });
    });
    const config = { url: `${api.origin}/team`, headers: { Authorization: 'Bearer ${secret:t}' }, itemsPath: 'items', pagination: { type: 'nextLink' as const, path: 'next' } };
    const next = await run({ adapter: 'rest', config, mapping, fields: { role: 'string' }, secrets: { t: SECRET } });
    expect(next).toMatchObject({ ok: false, code: 'failed', detail: 'it was sent to another server, which a sync never asks' });
    const moved = await run({ adapter: 'rest', config: { url: `${api.origin}/moved`, headers: { Authorization: 'Bearer ${secret:t}' } }, mapping, fields: { role: 'string' }, secrets: { t: SECRET } });
    expect(moved).toMatchObject({ ok: false, code: 'failed' });
    expect(elsewhere.seen).toHaveLength(0);
  });

  it('fails the whole read, never part of it: a refused sign-in, a reply with no list, pages that go round, a record with no title', async () => {
    const api = await server((req, res) => {
      if (req.url.pathname === '/locked') return send(res, { error: `bad token ${SECRET}` }, {}, 401);
      if (req.url.pathname === '/circle') return send(res, { items: people(1), next: 'same' });
      if (req.url.pathname === '/untitled') return send(res, [{ id: 1, fields: {} }]);
      send(res, { nothing: true });
    });
    expect(await run({ adapter: 'rest', config: { url: `${api.origin}/locked` }, mapping, fields: { role: 'string' } })).toMatchObject({ ok: false, code: 'auth' });
    expect(await run({ adapter: 'rest', config: { url: `${api.origin}/empty`, itemsPath: 'data.items' }, mapping, fields: { role: 'string' } })).toMatchObject({ ok: false, code: 'invalid', detail: 'there is no list of records at data.items' });
    expect(await run({ adapter: 'rest', config: { url: `${api.origin}/circle`, itemsPath: 'items', pagination: { type: 'cursor', param: 'c', cursorPath: 'next' } }, mapping, fields: { role: 'string' } })).toMatchObject({ ok: false, code: 'invalid', detail: 'its pages go round in a circle' });
    expect(await run({ adapter: 'rest', config: { url: `${api.origin}/untitled` }, mapping, fields: { role: 'string' } })).toMatchObject({ ok: false, code: 'invalid', detail: 'record 1 has no title at fields.fullName' });
    // A field the collection does not have is said, not dropped.
    expect(await run({ adapter: 'rest', config: { url: `${api.origin}/circle`, itemsPath: 'items' }, mapping: { ...mapping, values: { rank: 'fields.jobTitle' } }, fields: { role: 'string' } })).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('reads past a server that sends fewer than it was asked for on every page, and ends at a page that is not there', async () => {
    // Asked for 100 a page, it sends 2: the short first page is not the last.
    const capped = await server((req, res) => {
      const page = Number(req.url.searchParams.get('page'));
      if (page > 3) return send(res, { detail: 'Invalid page.' }, {}, 404);
      send(res, people(2, page * 2 - 1));
    });
    const reply = await run({ adapter: 'rest', config: { url: capped.origin, pagination: { type: 'page', param: 'page', sizeParam: 'size', size: 100 } }, mapping, fields: { role: 'string' } });
    expect(reply.ok && reply.records.map((r) => r.externalId)).toEqual(['1', '2', '3', '4', '5', '6']);
    // A page that is not there on the first request is a failure, not an empty source.
    const gone = await server((_req, res) => send(res, {}, {}, 404));
    expect(await run({ adapter: 'rest', config: { url: gone.origin, pagination: { type: 'page', param: 'page', size: 10 } }, mapping, fields: { role: 'string' } })).toMatchObject({ ok: false, code: 'failed' });
    // A server that sends a page again (its last, for any page past it, or one that ignores the page asked) cannot say
    // where its records end: the read fails rather than guess.
    const clamped = await server((req, res) => send(res, people(2, Math.min(Number(req.url.searchParams.get('page')), 2) * 2 - 1)));
    expect(await run({ adapter: 'rest', config: { url: clamped.origin, pagination: { type: 'page', param: 'page', size: 2 } }, mapping, fields: { role: 'string' } })).toMatchObject({ ok: false, code: 'invalid', detail: expect.stringContaining('its pages repeat') });
    // Part of a reply is never the whole of one.
    const partial = await server((_req, res) => send(res, people(1), {}, 206));
    expect(await run({ adapter: 'rest', config: { url: partial.origin }, mapping, fields: { role: 'string' } })).toMatchObject({ ok: false, code: 'failed', detail: 'the server sent only part of a reply' });
  });

  it('says what cannot be read as its field, rather than clearing it, and keeps drafts drafts however they are written', async () => {
    const api = await server((req, res) =>
      send(res, req.url.pathname === '/bad' ? [{ id: 1, name: 'A', age: 'N/A' }] : [{ id: 1, name: 'A', age: '41', hidden: 1 }, { id: 2, name: 'B', age: 7, hidden: '1' }, { id: 3, name: 'C', hidden: 0 }])
    );
    const ok = await run({ adapter: 'rest', config: { url: `${api.origin}/good` }, mapping: { title: 'name', draft: 'hidden', values: { age: 'age' } }, fields: { age: 'number' } });
    expect(ok.ok && ok.records.map((r) => [r.draft, r.values?.age])).toEqual([
      [true, 41],
      [true, 7],
      [false, undefined]
    ]);
    expect(await run({ adapter: 'rest', config: { url: `${api.origin}/bad` }, mapping: { title: 'name', values: { age: 'age' } }, fields: { age: 'number' } })).toMatchObject({ ok: false, code: 'invalid', detail: 'record 1’s age at age is not a number' });
    expect(await run({ adapter: 'rest', config: { url: `${api.origin}/good` }, mapping: { title: 'name', values: { lead: 'id' } }, fields: { lead: 'reference' } })).toMatchObject({ ok: false, code: 'invalid', detail: 'the lead field names other entries, which a sync does not fill in' });
  });

  it('samples: the first records as sent and as entries, with no picture fetched', async () => {
    const api = await server((_req, res) => send(res, people(5)));
    const reply = (await run({ adapter: 'rest', config: { url: api.origin }, mapping, fields: { role: 'string' }, mode: 'sample' })) as SyncReply & { fetched: string[] };
    expect(reply.ok && reply.raw).toEqual(people(3));
    expect(reply.ok && reply.records.map((r) => [r.externalId, r.title])).toEqual(people(5).map((p) => [String(p.id), p.fields.fullName]));
    expect(reply.ok && reply.images).toEqual([]);
    expect(reply.fetched).toEqual([]);
    // A picture a sync would refuse to fetch is said at once.
    const local = await server((_req, res, origin) => send(res, [{ id: 1, fields: { fullName: 'Ana', avatar: { url: `${origin}/me.png` } } }]));
    expect(await run({ adapter: 'rest', config: { url: local.origin }, mapping, fields: { role: 'string' }, mode: 'sample' })).toMatchObject({ ok: false, code: 'image', detail: 'a picture is on this computer or the local network, which a sync never reads' });
  });
});

describe('a GraphQL source', () => {
  it('posts its query with its variables, reads the list it names, and fails on any error in the reply', async () => {
    const api = await server((req, res) => {
      const { query, variables } = JSON.parse(req.body) as { query: string; variables: Record<string, unknown> };
      if (query.includes('broken')) return send(res, { data: { people: [] }, errors: [{ message: 'Cannot query field broken' }] });
      send(res, { data: { team: { nodes: [{ id: 'a', name: `First of ${String(variables.first)}` }] } } });
    });
    const ok = await run({ adapter: 'graphql', config: { url: api.origin, graphql: 'query People($first: Int) { team { nodes { id name } } }', variables: { first: 10 }, itemsPath: 'data.team.nodes' }, mapping: { title: 'name' } });
    expect(ok.ok && ok.records).toEqual([{ externalId: 'a', title: 'First of 10' }]);
    expect(api.seen[0].method).toBe('POST');
    const failed = await run({ adapter: 'graphql', config: { url: api.origin, graphql: '{ broken }' } });
    expect(failed).toMatchObject({ ok: false, code: 'failed', detail: 'the GraphQL server answered with an error: Cannot query field broken' });
  });

  it('reads the first list under data when it is not told where, and never takes one page of a connection for all of it', async () => {
    const api = await server((req, res) => {
      const { query } = JSON.parse(req.body) as { query: string };
      if (query.includes('paged')) return send(res, { data: { posts: { nodes: [{ id: 'p1', title: 'One' }], pageInfo: { hasNextPage: true, endCursor: 'x' } } } });
      send(res, { data: { people: [{ id: 'a', title: 'Ana' }] } });
    });
    const plain = await run({ adapter: 'graphql', config: { url: api.origin, graphql: '{ people { id title } }' } });
    expect(plain.ok && plain.records).toEqual([{ externalId: 'a', title: 'Ana' }]);
    expect(await run({ adapter: 'graphql', config: { url: api.origin, graphql: '{ paged: posts { nodes { id title } pageInfo { hasNextPage } } }', itemsPath: 'data.posts.nodes' } })).toMatchObject({ ok: false, code: 'too-large' });
  });
});

/** A Contentful Delivery API reply: two team members, each photo an asset the reply includes. */
const cda = {
  sys: { type: 'Array' },
  total: 2,
  skip: 0,
  limit: 100,
  items: [
    {
      sys: { id: 'ana', type: 'Entry', createdAt: '2026-03-04T10:00:00.000Z', updatedAt: '2026-03-05T10:00:00.000Z' },
      fields: {
        title: 'Ana Ruiz',
        slug: 'ana-ruiz',
        role: 'Architect',
        photo: { sys: { type: 'Link', linkType: 'Asset', id: 'photo-ana' } },
        mentor: { sys: { type: 'Link', linkType: 'Entry', id: 'ben' } },
        body: {
          nodeType: 'document',
          data: {},
          content: [
            { nodeType: 'heading-2', data: {}, content: [{ nodeType: 'text', value: 'About', marks: [], data: {} }] },
            {
              nodeType: 'paragraph',
              data: {},
              content: [
                { nodeType: 'text', value: 'Designs ', marks: [], data: {} },
                { nodeType: 'text', value: 'libraries', marks: [{ type: 'bold' }], data: {} },
                { nodeType: 'text', value: ' — see ', marks: [], data: {} },
                { nodeType: 'hyperlink', data: { uri: 'https://example.com/work' }, content: [{ nodeType: 'text', value: 'her work', marks: [], data: {} }] }
              ]
            },
            { nodeType: 'unordered-list', data: {}, content: [{ nodeType: 'list-item', data: {}, content: [{ nodeType: 'paragraph', data: {}, content: [{ nodeType: 'text', value: 'Leeds', marks: [], data: {} }] }] }] },
            { nodeType: 'embedded-asset-block', data: { target: { sys: { type: 'Link', linkType: 'Asset', id: 'photo-ana' } } }, content: [] }
          ]
        }
      }
    },
    { sys: { id: 'ben', type: 'Entry', createdAt: '2026-03-01T10:00:00.000Z' }, fields: { title: 'Ben Okafor', role: 'Engineer', mentor: { sys: { type: 'Link', linkType: 'Entry', id: 'ana' } } } }
  ],
  includes: { Asset: [{ sys: { id: 'photo-ana', type: 'Asset' }, fields: { title: 'Ana at the studio', file: { url: '//images.ctfassets.net/space/photo-ana/ana.png', contentType: 'image/png' } } }] }
};

describe('a Contentful source', () => {
  it('reads every entry of its content type with its token, resolves linked assets and entries, and turns Rich Text into entry text', async () => {
    const api = await server((req, res) => send(res, req.headers.authorization === `Bearer ${SECRET}` ? cda : { sys: { type: 'Error', id: 'AccessTokenInvalid' } }, {}, req.headers.authorization === `Bearer ${SECRET}` ? 200 : 401));
    const reply = await run(
      {
        adapter: 'contentful',
        config: { spaceId: 'space1', contentType: 'teamMember', credentials: { token: { $secret: 'cda' } } },
        mapping: { featuredImageUrl: 'fields.photo.fields.file.url', featuredImageAlt: 'fields.photo.fields.title', values: { role: 'fields.role', mentor: 'fields.mentor.fields.title' } },
        fields: { role: 'string', mentor: 'string' },
        secrets: { cda: SECRET }
      },
      { contentful: api.origin }
    );
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(api.seen[0].url.pathname).toBe('/spaces/space1/environments/master/entries');
    expect(Object.fromEntries(api.seen[0].url.searchParams)).toMatchObject({ content_type: 'teamMember', include: '2', skip: '0' });
    const [ana, ben] = reply.records;
    expect(ana).toMatchObject({
      externalId: 'ana',
      title: 'Ana Ruiz',
      slug: 'ana-ruiz',
      publishedAt: '2026-03-04',
      updatedAt: '2026-03-05',
      featuredImage: { $image: { url: 'https://images.ctfassets.net/space/photo-ana/ana.png', alt: 'Ana at the studio' } },
      values: { role: 'Architect', mentor: 'Ben Okafor' }
    });
    expect(ana.body).toEqual([
      { type: 'h2', spans: [{ text: 'About' }] },
      { type: 'p', spans: [{ text: 'Designs ' }, { text: 'libraries', strong: true }, { text: ' — see ' }, { text: 'her work', link: { type: 'url', target: 'https://example.com/work' } }] },
      { type: 'ul', items: [[{ text: 'Leeds' }]] },
      // The picture in its text, at its place, brought into the library as the sync goes.
      { type: 'image', assetId: '$image:https://images.ctfassets.net/space/photo-ana/ana.png', alt: 'Ana at the studio' }
    ]);
    // Links that go round (Ben's mentor is Ana, whose mentor is Ben) end where they would repeat.
    expect(ben.values).toEqual({ role: 'Engineer', mentor: 'Ana Ruiz' });
    expect(reply.images.map((i) => i.key)).toEqual(['url:https://images.ctfassets.net/space/photo-ana/ana.png']);
    // Every entry read, a page at a time, each from where the last ended.
    expect(api.seen.map((r) => r.url.searchParams.get('skip'))).toEqual(['0']);
    // Its token, refused: the author is told to check it.
    const refused = await run({ adapter: 'contentful', config: { spaceId: 'space1', contentType: 'teamMember', credentials: { token: { $secret: 'cda' } } }, secrets: { cda: 'wrong-token' } }, { contentful: api.origin });
    expect(refused).toMatchObject({ ok: false, code: 'auth' });
  });

  it('counts each link in Rich Text it cannot keep once, however many runs its words are (#1426)', () => {
    const text = (value: string, marks: string[] = []) => ({ nodeType: 'text', value, marks: marks.map((type) => ({ type })) });
    const doc = {
      nodeType: 'document',
      content: [
        { nodeType: 'paragraph', content: [{ nodeType: 'hyperlink', data: { uri: '/about/' }, content: [text('our '), text('studio', ['bold'])] }, text(' and '), { nodeType: 'entry-hyperlink', data: { target: { sys: { id: 'x' } } }, content: [text('Ben')] }] },
        { nodeType: 'unordered-list', content: [{ nodeType: 'list-item', content: [{ nodeType: 'paragraph', content: [{ nodeType: 'hyperlink', data: { uri: 'https://example.com/' }, content: [text('kept')] }] }] }] }
      ]
    };
    const read: LinkRead = { dropped: 0 };
    const blocks = contentfulRichText(doc, read);
    expect(read.dropped).toBe(2);
    expect(blocks[0]).toEqual({ type: 'p', spans: [{ text: 'our ' }, { text: 'studio', strong: true }, { text: ' and Ben' }] });
    expect(blocks[1]).toEqual({ type: 'ul', items: [[{ text: 'kept', link: { type: 'url', target: 'https://example.com/' } }]] });
    // Read from a page it was shown on, a relative one goes where it went there.
    const based: LinkRead = { base: 'https://old.example/posts/a/', dropped: 0 };
    expect(JSON.stringify(contentfulRichText(doc, based))).toContain('https://old.example/about/');
    expect(based.dropped).toBe(1);
    // Markdown's links are read as HTML's are.
    const md: LinkRead = { dropped: 0 };
    expect(markdownRichText('[home](/) and [mail](mailto:a@example.org)', md)).toEqual([{ type: 'p', spans: [{ text: 'home and ' }, { text: 'mail', link: { type: 'email', target: 'a@example.org' } }] }]);
    expect(md.dropped).toBe(1);
  });
});

describe('a Contentful source read page by page', () => {
  it('reads until it has as many entries as the space says, and fails when a reply does not say', async () => {
    const one = (id: string) => ({ sys: { id, createdAt: '2026-01-01T00:00:00Z' }, fields: { title: id } });
    const api = await server((req, res) => {
      const skip = Number(req.url.searchParams.get('skip'));
      if (req.url.pathname.includes('/broken/')) return send(res, { items: [one('x')], skip });
      if (req.url.pathname.includes('/short/')) return send(res, { items: skip ? [] : [one('a')], total: 3, skip });
      send(res, { items: [one(`e${skip}`)], total: 2, skip });
    });
    const env = { contentful: api.origin };
    const config = (space: string) => ({ spaceId: space, contentType: 't', credentials: { token: { $secret: 'c' } } });
    const paged = await run({ adapter: 'contentful', config: config('s'), secrets: { c: SECRET } }, env);
    expect(paged.ok && paged.records.map((r) => r.externalId)).toEqual(['e0', 'e1']);
    expect(await run({ adapter: 'contentful', config: config('broken'), secrets: { c: SECRET } }, env)).toMatchObject({ ok: false, code: 'invalid' });
    expect(await run({ adapter: 'contentful', config: config('short'), secrets: { c: SECRET } }, env)).toMatchObject({ ok: false, code: 'failed', detail: 'Contentful stopped before its last entry' });
  });
});

describe('Sanity, Strapi and WordPress sources', () => {
  it('Sanity: runs its GROQ query, with its token when it has one', async () => {
    const api = await server((req, res) => send(res, { result: [{ _id: 'p1', _createdAt: '2026-01-02T00:00:00Z', title: 'First', slug: { current: 'first' } }] }));
    const reply = await run({ adapter: 'sanity', config: { projectId: 'abc123', dataset: 'production', groq: '*[_type == "post"]', credentials: { token: { $secret: 's' } } }, secrets: { s: SECRET } }, { sanity: api.origin });
    expect(reply.ok && reply.records).toEqual([{ externalId: 'p1', title: 'First', slug: 'first', publishedAt: '2026-01-02' }]);
    expect(api.seen[0].url.pathname).toBe('/v2021-10-21/data/query/production');
    expect(api.seen[0].url.searchParams.get('query')).toBe('*[_type == "post"]');
    expect(api.seen[0].headers.authorization).toBe(`Bearer ${SECRET}`);
    // Without a token, none is sent; a draft (or a release's version) a token could read is never a record.
    const open = await server((_req, res) => send(res, { result: [{ _id: 'p1', title: 'Live' }, { _id: 'drafts.p1', title: 'Unpublished' }, { _id: 'versions.r1.p1', title: 'Planned' }] }));
    const unsigned = await run({ adapter: 'sanity', config: { projectId: 'abc123', dataset: 'production', groq: '*' } }, { sanity: open.origin });
    expect(unsigned.ok && unsigned.records.map((r) => r.title)).toEqual(['Live']);
    expect(open.seen[0].headers.authorization).toBeUndefined();
  });

  it('Strapi: reads 4’s attributes and 5’s flat documents alike, page by page, with media on the server made whole', async () => {
    const v4 = await server((req, res) => {
      const page = Number(req.url.searchParams.get('pagination[page]'));
      send(res, {
        data: [{ id: page, attributes: { title: `Post ${page}`, slug: `post-${page}`, publishedAt: '2026-02-0' + page + 'T00:00:00.000Z', cover: { data: { id: 9, attributes: { url: `/uploads/p${page}.png` } } } } }],
        meta: { pagination: { page, pageCount: 2 } }
      });
    });
    const four = await run({ adapter: 'strapi', config: { url: v4.origin, resource: 'articles' }, mode: 'sample' });
    expect(four.ok && four.records.map((r) => [r.externalId, r.title, r.publishedAt])).toEqual([
      ['1', 'Post 1', '2026-02-01'],
      ['2', 'Post 2', '2026-02-02']
    ]);
    // A picture on the CMS's own server is read at its whole address (a sync never fetches one from this computer).
    expect(four.ok && (four.raw as Array<{ cover: { url: string } }>).map((r) => r.cover.url)).toEqual([`${v4.origin}/uploads/p1.png`, `${v4.origin}/uploads/p2.png`]);
    expect(await run({ adapter: 'strapi', config: { url: v4.origin, resource: 'articles' }, mapping: { featuredImageUrl: 'cover.url' } })).toMatchObject({ ok: false, code: 'image' });
    // A field of its own called key never stands in for who a record is.
    const v5 = await server((_req, res) => send(res, { data: [{ id: 4, documentId: 'doc-abc', key: 'its-own', title: 'Hello', cover: { url: 'https://cdn.example/hello.png' } }], meta: { pagination: { page: 1, pageCount: 1 } } }));
    const five = await run({ adapter: 'strapi', config: { url: `${v5.origin}/`, resource: 'articles' }, mapping: { featuredImageUrl: 'cover.url' } });
    expect(five.ok && five.records).toEqual([{ externalId: 'doc-abc', title: 'Hello', featuredImage: { $image: { url: 'https://cdn.example/hello.png' } } }]);
    expect(v5.seen[0].url.pathname).toBe('/api/articles');
  });

  it('WordPress: reads every page its headers count, with each post’s featured image, author and words as text', async () => {
    const api = await server((req, res) => {
      const page = Number(req.url.searchParams.get('page'));
      send(
        res,
        [
          {
            id: page * 10,
            slug: `post-${page}`,
            status: page === 2 ? 'draft' : 'publish',
            date_gmt: '2026-04-0' + page + 'T09:00:00',
            title: { rendered: `Caf&eacute; &#8217;${page}&#8217;` },
            excerpt: { rendered: '<p>A short <em>excerpt</em>.</p>' },
            content: { rendered: '<h2>Hello</h2><p>The <strong>first</strong> words.</p>' },
            _embedded: { author: [{ name: 'Ana' }], 'wp:featuredmedia': [{ source_url: `https://cdn.example/wp${page}.jpg`, alt_text: 'A café' }] }
          }
        ],
        { 'x-wp-totalpages': '2' }
      );
    });
    const reply = await run({ adapter: 'wordpress', config: { url: `${api.origin}/blog` } });
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(api.seen.map((r) => r.url.pathname)).toEqual(['/blog/wp-json/wp/v2/posts', '/blog/wp-json/wp/v2/posts']);
    expect(reply.records[0]).toMatchObject({ externalId: '10', slug: 'post-1', publishedAt: '2026-04-01', draft: false, author: 'Ana', excerpt: 'A short excerpt .', featuredImage: { $image: { url: 'https://cdn.example/wp1.jpg', alt: 'A café' } } });
    expect(reply.records[0].title).toBe('Café ’1’');
    expect(reply.records[0].body).toEqual([
      { type: 'h2', spans: [{ text: 'Hello' }] },
      { type: 'p', spans: [{ text: 'The ' }, { text: 'first', strong: true }, { text: ' words.' }] }
    ]);
    expect(reply.records[1]).toMatchObject({ externalId: '20', draft: true, author: 'Ana', featuredImage: { $image: { url: 'https://cdn.example/wp2.jpg' } } });
    expect(api.seen.every((r) => r.url.searchParams.get('_embed') === '1')).toBe(true);
    // Its words read as text once: markup the post shows as words stays words.
    const shown = await server((_req, res) => send(res, [{ id: 1, title: { rendered: 'Using &lt;em&gt; well' } }], { 'x-wp-totalpages': '1' }));
    const once = await run({ adapter: 'wordpress', config: { url: shown.origin } });
    expect(once.ok && once.records[0].title).toBe('Using <em> well');
    // A full page with no count of pages beside it may not be the last.
    const uncounted = await server((_req, res) => send(res, Array.from({ length: 100 }, (_, i) => ({ id: i + 1, title: { rendered: `P${i}` } }))));
    expect(await run({ adapter: 'wordpress', config: { url: uncounted.origin } })).toMatchObject({ ok: false, code: 'invalid' });
  });

  it('WordPress: a post’s relative links go where they went on its own page (#1426)', async () => {
    const linksOf = (body: unknown) =>
      (body as Array<{ spans?: Array<{ text: string; link?: { type: string; target: string } }> }>).flatMap((b) => (b.spans ?? []).filter((s) => s.link).map((s) => [s.text, s.link!.type, s.link!.target]));
    const content =
      '<p><a href="/visit/access/?from=notice">Access</a>, <a href="../calendar/">the calendar</a>, <a href="#quiet-hours">quiet hours</a> and <a href="https://example.org/map">the map</a>.</p>';
    const api = await server((_req, res) => send(res, [{ id: 7, title: { rendered: 'Visiting' }, link: 'https://old.example/news/visiting/', content: { rendered: content } }], { 'x-wp-totalpages': '1' }));
    const reply = await run({ adapter: 'wordpress', config: { url: api.origin } });
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    // Its own page has no sections an entry can name, so a section goes to its place on that page.
    expect(linksOf(reply.records[0].body)).toEqual([
      ['Access', 'url', 'https://old.example/visit/access/?from=notice'],
      ['the calendar', 'url', 'https://old.example/news/calendar/'],
      ['quiet hours', 'url', 'https://old.example/news/visiting/#quiet-hours'],
      ['the map', 'url', 'https://example.org/map']
    ]);
    expect(reply.droppedLinks).toBeUndefined();

    // Each post from its own page, never another's: one with a query on its address, one with no web address at all.
    const posts = [
      {
        id: 1,
        title: { rendered: 'Edition' },
        link: 'https://old.example/news/visiting/?edition=2',
        content: {
          rendered:
            '<p><a href="../calendar/">a</a> <a href="?p=12">b</a> <a href="#quiet-hours">c</a> <a href="//media.example/x">d</a> <a href=" /a?x=1&amp;y=2 ">e</a> <a href="javascript:alert(1)">f</a> <a href="data:text/html,hi">g</a> <a href="https://[">h</a> <a href="">i</a> <a href="mailto:hi@example.org">j</a></p>'
        }
      },
      { id: 2, title: { rendered: 'No page' }, link: 'file:///etc/passwd', content: { rendered: '<p><a href="/visit/">k</a> <a href="https://example.org/ok">l</a></p>' } },
      { id: 3, title: { rendered: 'Missing' }, content: { rendered: '<p><a href="../x/">m</a></p>' } },
      // Another site's post, deeper: never read from the first post's page. Its name and password are never passed on.
      { id: 4, title: { rendered: 'Clean' }, link: 'https://editor:pw@other.example/deep/clean/', content: { rendered: '<p><a href="../ok/">n</a> <a href="tel:+44 20 7946 0000">o</a></p>' } },
      // Addresses a link cannot hold as they are, which would stop the whole sync: a quote in a host, mail and a number that are neither.
      { id: 5, title: { rendered: 'Odd' }, link: 'https://old.example/odd/', content: { rendered: '<p><a href="//a%22b.example/p">p</a> <a href="mailto:nobody">q</a> <a href="tel:abc">r</a></p>' } },
      // A page address so long that its sections are not read from it, though its site's other pages are.
      { id: 6, title: { rendered: 'Long' }, link: `https://old.example/${'a'.repeat(3000)}/`, content: { rendered: '<p><a href="#x">s</a> <a href="/short/">t</a></p>' } }
    ];
    const many = await server((_req, res) => send(res, posts, { 'x-wp-totalpages': '1' }));
    const two = await run({ adapter: 'wordpress', config: { url: many.origin } });
    expect(two.ok).toBe(true);
    if (!two.ok) return;
    expect(linksOf(two.records[0].body)).toEqual([
      ['a', 'url', 'https://old.example/news/calendar/'],
      ['b', 'url', 'https://old.example/news/visiting/?p=12'],
      ['c', 'url', 'https://old.example/news/visiting/?edition=2#quiet-hours'],
      ['d', 'url', 'https://media.example/x'],
      ['e', 'url', 'https://old.example/a?x=1&y=2'],
      ['j', 'email', 'hi@example.org']
    ]);
    // A post whose address is not a page on the web reads none of its relative links, and keeps its whole ones.
    expect(linksOf(two.records[1].body)).toEqual([['l', 'url', 'https://example.org/ok']]);
    expect(linksOf(two.records[2].body)).toEqual([]);
    expect(linksOf(two.records[3].body)).toEqual([
      ['n', 'url', 'https://other.example/deep/ok/'],
      ['o', 'tel', '+44 20 7946 0000']
    ]);
    expect(linksOf(two.records[4].body)).toEqual([]);
    expect(linksOf(two.records[5].body)).toEqual([['t', 'url', 'https://old.example/short/']]);
    // Every link it could not keep keeps its words.
    const words = (body: unknown) => (body as Array<{ spans: Array<{ text: string }> }>).map((b) => b.spans.map((x) => x.text).join('')).join('|');
    expect(words(two.records[0].body)).toBe('a b c d e f g h i j');
    expect(words(two.records[4].body)).toBe('p q r');
    expect(words(two.records[5].body)).toBe('s t');
    // Script, data, a broken address and a link to nowhere keep their words, and are said, by the records they are in.
    expect(two.droppedLinks).toEqual({ count: 10, records: 5, first: [0, 1, 2] });
  });

  it('WordPress: never reads links from a post address that holds a secret the source was sent, however it is spelled (#1426)', async () => {
    const encoded = SECRET.replace(/^t/, '%74');
    const api = await server((_req, res) =>
      send(res, [{ id: 1, title: { rendered: 'Shared' }, link: `https://old.example/post/?share=${encoded}`, content: { rendered: '<p><a href="#part">part</a> <a href="https://example.org/">kept</a></p>' } }], { 'x-wp-totalpages': '1' })
    );
    const reply = await run({ adapter: 'wordpress', config: { url: api.origin }, secrets: { wp: SECRET } });
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(JSON.stringify(reply.records)).not.toContain(encoded);
    expect(reply.records[0].body).toEqual([{ type: 'p', spans: [{ text: 'part ' }, { text: 'kept', link: { type: 'url', target: 'https://example.org/' } }] }]);
    expect(reply.droppedLinks).toEqual({ count: 1, records: 1, first: [0] });
  });

  it('A source with no page to read its text from says the relative links it could not keep (#1426)', async () => {
    const rest = await server((_req, res) => send(res, [{ id: 'a', title: 'A', body: '<p><a href="/about/">About</a> and <a href="https://example.org/">us</a></p>' }, { id: 'b', title: 'B', body: '<p>None</p>' }]));
    const reply = await run({ adapter: 'rest', config: { url: rest.origin }, mapping: { body: 'body', bodyFormat: 'html' } });
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    // Its API's address is not where its text was shown, so it is never read from.
    expect(reply.records[0].body).toEqual([{ type: 'p', spans: [{ text: 'About and ' }, { text: 'us', link: { type: 'url', target: 'https://example.org/' } }] }]);
    expect(reply.droppedLinks).toEqual({ count: 1, records: 1, first: [0] });
  });
});

describe('what a source sends, checked as hard as what it is sent', () => {
  it('never takes part of a read for all of it, however a server pages', async () => {
    const one = (id: string) => ({ sys: { id }, fields: { title: id } });
    const api = await server((req, res) => {
      const p = req.url.pathname;
      if (p.includes('/noskip/')) return send(res, { items: [one('a')], total: 1 });
      if (p === '/api/articles') return send(res, { data: [{ id: 1, documentId: 'd1', title: 'One' }] });
      if (p === '/wp-json/wp/v2/posts') return send(res, Number(req.url.searchParams.get('page')) === 1 ? [{ id: 1, title: { rendered: 'One' } }] : [], { 'x-wp-totalpages': '3' });
      if (p === '/gql') return send(res, { data: { nodes: [{ id: 'x', title: 'X' }], pageInfo: { hasNextPage: true } } });
      // A Link header whose quoted title holds a comma before its rel.
      const at = Number(req.url.searchParams.get('at') ?? 0);
      send(res, people(1, at + 1), at < 2 ? { link: `<${'http://' + req.headers.host}/?at=${at + 1}>; title="Page ${at + 2}, continued"; rel=next` } : {});
    });
    expect(await run({ adapter: 'contentful', config: { spaceId: 'noskip', contentType: 't', credentials: { token: { $secret: 'c' } } }, secrets: { c: SECRET } }, { contentful: api.origin })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await run({ adapter: 'strapi', config: { url: api.origin, resource: 'articles' } })).toMatchObject({ ok: false, code: 'invalid', detail: 'Strapi did not say how many pages there are' });
    expect(await run({ adapter: 'wordpress', config: { url: api.origin } })).toMatchObject({ ok: false, code: 'failed', detail: 'the site stopped before its last page of posts' });
    expect(await run({ adapter: 'graphql', config: { url: `${api.origin}/gql`, graphql: '{ nodes { id title } pageInfo { hasNextPage } }' } })).toMatchObject({ ok: false, code: 'too-large' });
    const linked = await run({ adapter: 'rest', config: { url: api.origin, pagination: { type: 'nextLink' } }, mapping: { title: 'fields.fullName' } });
    expect(linked.ok && linked.records.map((r) => r.externalId)).toEqual(['1', '2', '3']);
  });

  it('fills a secret into JSON as JSON writes it, and reads what its mapping names before anything else', async () => {
    const api = await server((req, res) => send(res, req.url.pathname === '/empty' ? [] : req.url.pathname === '/pics' ? [{ id: 1, title: 'A', img: 'file:///etc/photo.png', bio: '<p>Hi</p><img src="https://cdn.example/a.png">' }] : [{ id: 1, title: JSON.parse(req.body).token }]));
    const quoted = 'tok"with\\quote-123';
    const posted = await run({ adapter: 'rest', config: { url: `${api.origin}/echo`, method: 'POST', body: '{"token":"${secret:t}"}' }, secrets: { t: quoted }, mode: 'sample' });
    expect(posted.ok && posted.records[0].title).toBe(quoted);
    // A mapping to a field it cannot fill is said with no record to read, so an empty source never looks right.
    expect(await run({ adapter: 'rest', config: { url: `${api.origin}/empty` }, mapping: { values: { lead: 'id' } }, fields: { lead: 'reference' } })).toMatchObject({ ok: false, code: 'invalid' });
    expect(api.seen.filter((r) => r.url.pathname === '/empty')).toHaveLength(0);
    // A picture address that is not on the web is said; a rich text field keeps words, not pictures.
    expect(await run({ adapter: 'rest', config: { url: `${api.origin}/pics` }, mapping: { featuredImageUrl: 'img' } })).toMatchObject({ ok: false, code: 'invalid', detail: 'record 1’s featured image at img is not a picture’s web address' });
    const words = await run({ adapter: 'rest', config: { url: `${api.origin}/pics` }, mapping: { values: { bio: 'bio' } }, fields: { bio: 'richtext' }, mode: 'sample' });
    expect(words.ok && words.records[0].values).toEqual({ bio: [{ type: 'p', spans: [{ text: 'Hi' }] }] });
  });

  it('remembers the count a read began with, follows only the link a Link header calls next, and never sends a post on', async () => {
    const one = (id: string) => ({ sys: { id }, fields: { title: id } });
    const api = await server((req, res, origin) => {
      const p = req.url.pathname;
      const skip = Number(req.url.searchParams.get('skip') ?? 0);
      if (p.includes('/shrinking/')) return send(res, { items: skip ? [] : [one('a')], total: skip ? 1 : 3, skip });
      if (p === '/api/articles') {
        const page = Number(req.url.searchParams.get('pagination[page]'));
        return send(res, page === 1 ? { data: [{ id: 1, title: 'One' }], meta: { pagination: { pageCount: 3 } } } : { data: [] });
      }
      if (p === '/moved') {
        res.writeHead(307, { location: '/other' });
        return res.end();
      }
      if (p === '/next') return send(res, people(1, 9));
      // A previous page whose quoted title mentions rel=next.
      send(res, people(1), { link: `<${origin}/prev>; title="see; rel=next page"; rel=prev, <${origin}/next>; rel="next"` });
    });
    expect(await run({ adapter: 'contentful', config: { spaceId: 'shrinking', contentType: 't', credentials: { token: { $secret: 'c' } } }, secrets: { c: SECRET } }, { contentful: api.origin })).toMatchObject({ ok: false, code: 'failed' });
    expect(await run({ adapter: 'strapi', config: { url: api.origin, resource: 'articles' } })).toMatchObject({ ok: false, code: 'failed' });
    const linked = await run({ adapter: 'rest', config: { url: `${api.origin}/start`, pagination: { type: 'nextLink' } }, mapping: { title: 'fields.fullName' } });
    expect(linked.ok && linked.records.map((r) => r.externalId)).toEqual(['1', '9']);
    expect(api.seen.some((r) => r.url.pathname === '/prev')).toBe(false);
    expect(await run({ adapter: 'rest', config: { url: `${api.origin}/moved`, method: 'POST', body: '{"q":1}' }, mapping: { title: 'fields.fullName' } })).toMatchObject({ ok: false, code: 'failed', detail: 'the server redirected what was posted to it, which a sync never follows' });
    expect(api.seen.some((r) => r.url.pathname === '/other')).toBe(false);
  });

  it('checks a sample’s pictures by where their hosts lead, as a sync does', async () => {
    const api = await server((_req, res) => send(res, [{ id: 1, title: 'A', img: 'https://looks-public.example/a.png' }]));
    const reply = await runSync(
      { id: 1, adapter: 'rest', config: { url: api.origin }, mapping: { featuredImageUrl: 'img' }, mode: 'sample', secrets: {}, known: {} },
      { adapters: ADAPTERS, fetchImage: async () => ({ bytes: new Uint8Array(), mime: 'image/png' }), checkHost: async () => 'a picture is on this computer or the local network, which a sync never reads' }
    );
    expect(reply).toMatchObject({ ok: false, code: 'image' });
  });
});

describe('a source’s settings', () => {
  const doc = (adapter: string, config: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, id: 'team-api', name: 'Team API', adapter, collectionId: 'team', config, ...extra });

  it('name every credential, never hold one, in any header, query value or address', () => {
    expect(sourceDocProblem(doc('rest', { url: 'https://api.example/team', headers: { Authorization: 'Bearer ${secret:team-token}', 'X-Client': 'site' }, query: { api_key: '${secret:key}' } }))).toBeNull();
    expect(sourceDocProblem(doc('rest', { url: 'https://api.example/team', headers: { Authorization: `Bearer ${SECRET}` } }))).toMatch(/must name a secret/);
    expect(sourceDocProblem(doc('rest', { url: 'https://api.example/team', headers: { Authorization: `Bearer ${SECRET} \${secret:x}` } }))).toMatch(/must name a secret/);
    expect(sourceDocProblem(doc('rest', { url: 'https://api.example/team', query: { access_token: SECRET } }))).toMatch(/must name a secret/);
    expect(sourceDocProblem(doc('rest', { url: `https://api.example/team?token=${SECRET}` }))).toMatch(/carries a credential/);
    expect(sourceDocProblem(doc('rest', { url: 'https://user:pass@api.example/team' }))).toMatch(/signs in/);
    expect(sourceDocProblem(doc('rest', { url: 'https://api.example/team', headers: { 'X-Thing': '${secret:}' } }))).toMatch(/cannot be read/);
    expect(sourceDocProblem(doc('rest', { url: 'https://api.example/team', headers: { Authorization: 'Bearer ' } }))).toMatch(/must name a secret/);
    // In what it sends as JSON too, at any depth.
    expect(sourceDocProblem(doc('rest', { url: 'https://a.example', method: 'POST', body: '{"auth":{"password":"hunter22"}}' }))).toMatch(/must name a secret/);
    expect(sourceDocProblem(doc('rest', { url: 'https://a.example', method: 'POST', body: '{"auth":{"password":"${secret:pw}"}}' }))).toBeNull();
    expect(sourceDocProblem(doc('graphql', { url: 'https://a.example', graphql: '{ a }', variables: { accessToken: 'abc123def' } }))).toMatch(/must name a secret/);
    expect(sourceDocProblem(doc('graphql', { url: 'https://a.example', graphql: 'mutation { a }' }))).toMatch(/only ask a query/);
    // Credentials by the words a name is made of, in lists and as numbers too; an ordinary word that holds one is none.
    expect(sourceDocProblem(doc('graphql', { url: 'https://a.example', graphql: '{ a }', variables: { keyword: 'garden', monkey: 'x' } }))).toBeNull();
    expect(sourceDocProblem(doc('graphql', { url: 'https://a.example', graphql: '{ a }', variables: { password: ['hunter22'] } }))).toMatch(/must name a secret/);
    expect(sourceDocProblem(doc('rest', { url: 'https://a.example', method: 'POST', body: '{"token":123456}' }))).toMatch(/must name a secret/);
    expect(sourceDocProblem(doc('rest', { url: 'https://a.example', headers: { 'X-Api-Key': 'abc123' } }))).toMatch(/must name a secret/);
    // Everything under a name that carries one does, however deep.
    expect(sourceDocProblem(doc('rest', { url: 'https://a.example', method: 'POST', body: '{"credentials":{"value":"unsaved-example-token"}}' }))).toMatch(/must name a secret/);
    // And a secret named deep in what it sends is one it sends.
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: '${secret:deep}' } } } } } } } } };
    expect(sourceSecretNames(doc('graphql', { url: 'https://a.example', graphql: '{ a }', variables: deep }) as never)).toEqual(['deep']);
    expect(sourceDocProblem(doc('contentful', { spaceId: 's', contentType: 't' }))).toMatch(/needs a secret/);
    expect(sourceDocProblem(doc('wordpress', { url: 'https://blog.example', spaceId: 'x' }))).toMatch(/does not take/);
    expect(sourceSecretNames(doc('rest', { url: 'https://a.example', headers: { Authorization: 'Bearer ${secret:b}' }, query: { key: '${secret:a}' } }) as never)).toEqual(['a', 'b']);
  });

  it('only read: a GraphQL mutation or subscription, a converter beside a mapping, a mapping to no detail are refused', () => {
    expect(graphqlReadProblem('query { people { id } }')).toBeNull();
    expect(graphqlReadProblem('# mutation in a comment\n{ people(note: "mutation") { id } }')).toBeNull();
    expect(graphqlReadProblem('mutation { deletePeople }')).toMatch(/only ask a query/);
    expect(graphqlReadProblem('query Q { a } subscription S { b }')).toMatch(/only ask a query/);
    // A comment ends at a carriage return as at a line feed, and a comment's quotes hide nothing.
    expect(graphqlReadProblem('# comment\rmutation { deletePeople }')).toMatch(/only ask a query/);
    expect(graphqlReadProblem('# """\nmutation { wipe }\n# """\n{ a }')).toMatch(/only ask a query/);
    expect(graphqlReadProblem('{ a(note: """mutation""") }')).toBeNull();
    expect(graphqlReadProblem('{ a(note: "never ends) }')).toMatch(/never ends/);
    expect(sourceDocProblem(doc('rest', { url: 'https://a.example' }, { mapping: { title: 'name' }, converter: { file: 'converter.mjs' } }))).toMatch(/both a converter and a mapping/);
    expect(sourceDocProblem(doc('rest', { url: 'https://a.example' }, { mapping: { headline: 'name' } }))).toMatch(/names one no entry has/);
    expect(sourceDocProblem(doc('rest', { url: 'https://a.example' }, { converter: { file: '../../evil.mjs' } }))).toMatch(/converter is not converter.mjs/);
  });

  it('read paths only through a record’s own details', () => {
    expect(pathSteps('fields.avatar.url')).toEqual(['fields', 'avatar', 'url']);
    expect(pathSteps('items[0].tags[2]')).toEqual(['items', 0, 'tags', 2]);
    expect(pathSteps('a..b')).toBeNull();
    expect(readPath({ a: [{ b: 'x' }] }, 'a[0].b')).toBe('x');
    expect(readPath({}, '__proto__.polluted')).toBeUndefined();
    expect(readPath(Object.create({ inherited: 'sentinel' }), 'inherited')).toBeUndefined();
    expect(readPath({ a: 'text' }, 'a.length')).toBeUndefined();
  });
});
