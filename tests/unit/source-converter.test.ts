/**
 * Converters (#678): the author's own converter.mjs, checked by its syntax tree before it ever runs (no import of any
 * kind, no dynamic code, nothing that reaches Node or out of the language), then run in a context of its own that can
 * compile no code from text and that nothing of the worker's enters. Its helpers read text and, in fetchAll, ask the
 * source's own server only, with secrets the worker fills in and the converter never sees.
 */
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ConverterError, converterProblems, converterProblemText, runConverter, type ConverterHost } from '../../src/main/sources/converter';
import { runSync } from '../../src/main/sources/run';
import { ADAPTERS } from '../../src/main/sources/adapters';

const host: ConverterHost = { richText: (kind, text) => [{ type: 'p', spans: [{ text: `${kind}:${text}` }] }] };
const items = async () => [{ id: 7, name: 'Ana', photo: '//cdn.example/ana.png', joined: '2026-05-06T10:00:00Z', bio: '<p>Hi</p>' }];

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

describe('a converter’s check', () => {
  const problems = (code: string) => converterProblems(code).map((p) => p.message);

  it('passes a module of functions and constants exporting convert (and fetchAll)', () => {
    expect(converterProblems('const ROLE = "x";\nfunction clean(s) { return s.trim(); }\nexport function convert(items, helpers) { return items.map((i) => ({ externalId: String(i.id), title: clean(i.name) })); }\nexport async function fetchAll(h) { return h.fetchJson("/all"); }')).toEqual([]);
    expect(converterProblems('export const convert = (items) => items;')).toEqual([]);
  });

  it('refuses any import, Node, dynamic code and the ways out of the language, by line, before anything runs', () => {
    const cases: Array<[string, RegExp]> = [
      ['import fs from "node:fs";\nexport function convert(i) { return i; }', /imports a module/],
      ['export function convert(i) { return require("child_process"); }', /uses require/],
      ['export function convert(i) { return eval("i"); }', /uses eval/],
      ['export function convert(i) { return new Function("return 1")(); }', /uses Function/],
      ['export function convert(i) { return import("node:fs"); }', /loads a module with import\(\)/],
      ['export function convert(i) { return i.constructor.constructor("return process")(); }', /uses constructor/],
      ['export function convert(i) { return i["__proto__"]; }', /uses __proto__/],
      ['export function convert(i) { return i[`constructor`]; }', /uses constructor/],
      ['export function convert(i) { return process.env; }', /uses process/],
      ['export function convert(i) { return globalThis.fetch; }', /uses globalThis/],
      ['export function convert(i) { fetch("https://evil.example"); return i; }', /uses fetch/],
      ['export function convert(i) { with (i) { return x; } }', /cannot be read as JavaScript|uses with/],
      ['export function convert(i) { return import.meta.url; }', /import\.meta/],
      ['export * from "./other.mjs";', /exports in a way/],
      ['export default function (i) { return i; }', /exports in a way/],
      ['export let convert = (i) => i;', /can change/],
      ['console.log("hi");\nexport function convert(i) { return i; }', /Only functions and constants/],
      ['export function transform(i) { return i; }', /exports transform|exports no convert/],
      ['export function convert(i) { return i', /cannot be read as JavaScript/]
    ];
    for (const [code, want] of cases) expect(problems(code).join(' '), code).toMatch(want);
    // Where each is, as the author reads it.
    expect(converterProblemText(converterProblems('const a = 1;\nexport function convert(i) {\n  return require("fs");\n}'))).toMatch(/^Line 3: It uses require/);
  });
});

describe('a converter run', () => {
  it('puts records in shape with its helpers', async () => {
    const code = `export function convert(items, h) {
      return items.map((i) => ({
        externalId: String(i.id),
        title: i.name,
        publishedAt: h.date(i.joined),
        featuredImage: h.image(i.photo, { alt: i.name }),
        body: h.richText.fromHtml(i.bio),
        values: { first: h.get(i, 'name') }
      }));
    }`;
    const out = await runConverter(code, host, items);
    expect(out.records).toEqual([
      { externalId: '7', title: 'Ana', publishedAt: '2026-05-06', featuredImage: { $image: { url: 'https://cdn.example/ana.png', alt: 'Ana' } }, body: [{ type: 'p', spans: [{ text: 'html:<p>Hi</p>' }] }], values: { first: 'Ana' } }
    ]);
  });

  it('reads the source its own way with fetchAll, through the worker only', async () => {
    const asked: string[] = [];
    const out = await runConverter(
      'export async function fetchAll(h) { const a = await h.fetchJson("/people?page=1"); const b = await h.fetchJson("/people?page=2"); return [...a.items, ...b.items]; }\nexport function convert(items) { return items.map((i) => ({ externalId: i.id, title: i.n })); }',
      { ...host, fetchJson: async (url) => (asked.push(url), { items: [{ id: url.slice(-1), n: `Page ${url.slice(-1)}` }] }) },
      async () => {
        throw new Error('fetchAll reads instead');
      }
    );
    expect(asked).toEqual(['/people?page=1', '/people?page=2']);
    expect(out.records).toEqual([
      { externalId: '1', title: 'Page 1' },
      { externalId: '2', title: 'Page 2' }
    ]);
    // convert itself cannot ask anything, whatever the worker could answer.
    await expect(runConverter('export function convert(items, h) { return [h.fetchJson === undefined]; }', { ...host, fetchJson: async () => [] }, items)).resolves.toMatchObject({ records: [true] });
  });

  it('cannot compile code from text, or reach the worker, however the names are spelled', async () => {
    // A name the check cannot see, put together as it runs: the context's own Function, which compiles nothing.
    const escape = 'export function convert(items) { const k = ["constr", "uctor"].join(""); return [][k][k]("return process")().pid; }';
    expect(converterProblems(escape)).toEqual([]);
    const e = await runConverter(escape, host, items).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ConverterError);
    expect((e as Error).message).toMatch(/^Its convert failed/);
    expect((e as Error).message).toMatch(/[Cc]ode generation from strings disallowed/);
    // Nor is there a global object to reach the helpers' own bridge through.
    const self = await runConverter('export function convert() { return [typeof this, typeof __job]; }', host, items);
    expect(self.records).toEqual(['undefined', 'object']);
    // What it can see beside it (the run it is part of) is the context's own: a list whose Function compiles nothing.
    const job = 'export function convert() { const k = ["constr", "uctor"].join(""); return [__job[k][k]("return 1")()]; }';
    await expect(runConverter(job, host, items)).rejects.toThrow(/[Cc]ode generation from strings disallowed/);
    // So is fetchAll's, the worker's answer kept inside a function of the context's.
    const fetching = 'export async function fetchAll() { const k = ["constr", "uctor"].join(""); return [__job[2][k][k]("return 1")()]; }\nexport function convert(i) { return i; }';
    await expect(runConverter(fetching, { ...host, fetchJson: async () => [] }, items)).rejects.toThrow(/^Its fetchAll failed.*[Cc]ode generation from strings disallowed/);
    // Nor can a stack's frames be read.
    const frames = 'export function convert() { const k = ["prepare", "StackTrace"].join(""); try { Error[k] = (e, f) => f; } catch (e) { return ["refused"]; } return [typeof new Error().stack]; }';
    expect((await runConverter(frames, host, items)).records).toEqual(['refused']);
  });

  it('is stopped when it runs too long, and says what it got wrong', async () => {
    await expect(runConverter('export function convert() { for (;;) {} }', host, items, { timeoutMs: 100 })).rejects.toThrow('Its convert took longer than 0.1 seconds');
    const slowStart = 'const x = (() => { for (;;) {} })();\nexport function convert(i) { return i; }';
    expect(converterProblems(slowStart)).toEqual([]);
    await expect(runConverter(slowStart, host, items, { timeoutMs: 100 })).rejects.toThrow('Its module took longer than 0.1 seconds');
    await expect(runConverter('export async function convert(i) { return i; }', host, items)).rejects.toThrow(/not a promise/);
    await expect(runConverter('export function convert(i) { throw new Error("no name for " + i[0].id); }', host, items)).rejects.toThrow('Its convert failed (line 1): no name for 7');
    await expect(runConverter('export async function fetchAll() { return { not: "a list" }; }\nexport function convert(i) { return i; }', host, items)).rejects.toThrow('Its fetchAll gave no list of records.');
  });
});

describe('a converter, given what the source sent', () => {
  it('is never given a secret the source sent back, nor shows a library picture by its ID', async () => {
    const s = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      // A server that echoes the token it was sent.
      res.end(JSON.stringify([{ id: 1, name: 'Ana', debug: req.headers.authorization }]));
    });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
    const base = { id: 1, adapter: 'rest', config: { url: origin, headers: { Authorization: 'Bearer ${secret:api}' } }, secrets: { api: 'tok-abcdef0123456789' }, known: {} };
    const deps = { adapters: ADAPTERS, fetchImage: async () => ({ bytes: new Uint8Array([1]), mime: 'image/png' }) };
    const reversed = 'export function convert(items) { return items.map((i) => ({ externalId: String(i.id), title: i.name, excerpt: String(i.debug).split("").reverse().join("") })); }';
    const echoed = await runSync({ ...base, converter: reversed }, deps);
    expect(echoed).toMatchObject({ ok: false, code: 'invalid', detail: 'the source sent back one of the secrets it was sent, which a converter is never given' });
    const viaFetch = await runSync({ ...base, converter: `export async function fetchAll(h) { return h.fetchJson("/"); }\n${reversed}` }, deps);
    expect(viaFetch.ok === false && viaFetch.detail).toMatch(/sent back one of the secrets/);
    // A picture in text is one the source has, by its address: never the project's own library image.
    const library = await runSync({ ...base, config: { url: origin }, converter: 'export function convert(items) { return items.map((i) => ({ externalId: String(i.id), title: i.name, body: [{ type: "image", assetId: "img_logo", alt: "" }] })); }' }, deps);
    expect(library).toMatchObject({ ok: false, code: 'invalid' });
    const notWeb = await runSync({ ...base, config: { url: origin }, converter: 'export function convert(items) { return items.map((i) => ({ externalId: String(i.id), title: i.name, body: [{ type: "image", assetId: "$image:file:///etc/photo.png", alt: "" }] })); }' }, deps);
    expect(notWeb).toMatchObject({ ok: false, code: 'image' });
  });
});

describe('a source read by its converter', () => {
  it('converts what its kind read, asks only its own server in fetchAll, and never sees its secrets', async () => {
    let origin = '';
    const seen: Array<{ url: string; auth?: string }> = [];
    const s = createServer((req, res) => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ id: 1, name: 'Ana', photo: 'https://cdn.example/ana.png' }]));
    });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
    const base = { id: 1, adapter: 'rest', config: { url: `${origin}/people`, headers: { Authorization: 'Bearer ${secret:api}' } }, secrets: { api: 'tok-1234567890abcdef' }, known: {}, fields: { photo: 'image' } };
    const deps = { adapters: ADAPTERS, fetchImage: async () => ({ bytes: new Uint8Array([1]), mime: 'image/png' }) };
    const converted = await runSync({ ...base, converter: 'export function convert(items) { return items.map((i) => ({ externalId: i.id, title: i.name, values: { photo: i.photo } })); }' }, deps);
    expect(converted).toMatchObject({ ok: true, records: [{ externalId: '1', title: 'Ana', values: { photo: { $image: { url: 'https://cdn.example/ana.png' } } } }] });
    expect(seen[0]).toEqual({ url: '/people', auth: 'Bearer tok-1234567890abcdef' });
    // Its own requests carry the source's headers, filled in by the worker; one to another server is never sent.
    const own = await runSync({ ...base, converter: 'export async function fetchAll(h) { return h.fetchJson("/people?all=1"); }\nexport function convert(items) { return items.map((i) => ({ externalId: i.id, title: i.name })); }' }, deps);
    expect(own).toMatchObject({ ok: true });
    expect(seen[1]).toEqual({ url: '/people?all=1', auth: 'Bearer tok-1234567890abcdef' });
    const away = await runSync({ ...base, converter: 'export async function fetchAll(h) { return h.fetchJson("https://elsewhere.example/steal"); }\nexport function convert(i) { return i; }' }, deps);
    expect(away).toMatchObject({ ok: false, code: 'converter' });
    expect(away.ok === false && away.detail).toMatch(/^Its fetchAll failed( \(line 1\))?: it was sent to another server, which a sync never asks$/);
    expect(seen).toHaveLength(2);
    // It only reads: no POST to a REST source, whatever it would send.
    const write = await runSync({ ...base, converter: 'export async function fetchAll(h) { return h.fetchJson("/people", { method: "POST", body: { delete: true } }); }\nexport function convert(i) { return i; }' }, deps);
    expect(write).toMatchObject({ ok: false, code: 'converter' });
    expect(write.ok === false && write.detail).toMatch(/a converter only reads: it asks with GET$/);
    // Nor a GraphQL mutation, however it is sent.
    const gql = await runSync({ ...base, adapter: 'graphql', config: { url: `${origin}/gql`, graphql: '{ people { id } }' }, converter: 'export async function fetchAll(h) { return h.fetchJson("/gql", { method: "POST", body: { query: "mutation { wipe }" } }); }\nexport function convert(i) { return i; }' }, deps);
    expect(gql.ok === false && gql.detail).toMatch(/changes or watches data/);
    // A secret is never filled into a query, where it could change what the query asks.
    const filled = await runSync({ ...base, adapter: 'graphql', config: { url: `${origin}/gql`, graphql: '{ people { id } }' }, converter: 'export async function fetchAll(h) { return h.fetchJson("/gql", { method: "POST", body: { query: "# ${secret:api}\\n{ a }" } }); }\nexport function convert(i) { return i; }' }, deps);
    expect(filled.ok === false && filled.detail).toMatch(/names a secret in its GraphQL query/);
    // A query is posted only to the source's own address for queries.
    const elsewhere = await runSync({ ...base, adapter: 'graphql', config: { url: `${origin}/gql`, graphql: '{ people { id } }' }, converter: 'export async function fetchAll(h) { return h.fetchJson("/admin/run", { method: "POST", body: { query: "{ a }" } }); }\nexport function convert(i) { return i; }' }, deps);
    expect(elsewhere.ok === false && elsewhere.detail).toMatch(/only to the source’s own address/);
    expect(seen).toHaveLength(2);
    // A converter that may not run is refused, by its check, before the source is asked anything.
    const unsafe = await runSync({ ...base, converter: 'import fs from "node:fs";\nexport function convert(i) { return i; }' }, deps);
    expect(unsafe).toMatchObject({ ok: false, code: 'converter', detail: expect.stringContaining('Line 1: It imports a module') });
    expect(seen).toHaveLength(2);
  });
});
