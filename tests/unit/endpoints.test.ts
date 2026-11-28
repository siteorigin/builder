/**
 * The project's own API endpoints (#1481): which files are endpoints, the route and handlers each has, where a new one
 * goes, and reading, saving and making them on disk without following a link or overwriting an edit made meanwhile.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { endpointFileFor, endpointMethods, endpointRoute, endpointStarter, isEndpointFile, newEndpointProblem, newEndpointRoute, parseHeaderLines, shownBody } from '@shared/endpoints';
import { createEndpoint, endpointHash, listEndpoints, readEndpoint, saveEndpoint } from '../../src/main/project/endpoints';

const dirs: string[] = [];
const temp = () => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'so-endpoints-')));
  dirs.push(d);
  return d;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const write = (dir: string, rel: string, text: string) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
/** A write fence that always writes, as the controller's does for a project this app owns. */
const open = async (w: () => Promise<void>) => (await w(), true);

describe('endpoint files', () => {
  it('are +server.js and +server.ts files under src/routes, through plain folders', () => {
    for (const f of ['src/routes/api/search/+server.ts', 'src/routes/+server.js', 'src/routes/(admin)/api/[id]/+server.js']) expect(isEndpointFile(f), f).toBe(true);
    for (const f of ['src/routes/api/search/+page.svelte', 'src/routes/api/+server.mjs', 'src/lib/+server.js', 'src/routes/../+server.js', 'src/routes/./x/+server.ts', 'src\\routes\\x\\+server.js', '/src/routes/x/+server.js', 'src/routes/x/+server.ts/']) expect(isEndpointFile(f), f).toBe(false);
  });

  it('are known by their route, groups left out as they are from the address', () => {
    expect(endpointRoute('src/routes/api/search/+server.ts')).toBe('/api/search');
    expect(endpointRoute('src/routes/(admin)/api/posts/[id]/+server.js')).toBe('/api/posts/[id]');
    expect(endpointRoute('src/routes/+server.js')).toBe('/');
  });

  it('say which handlers they export, however they export them', () => {
    const source = `export async function GET() {}\nexport const POST = async () => {};\nfunction remove() {}\nexport { remove as DELETE, helper };\nexport function fallback() {}\nexport const GETTER = 1;\nconst PUT = 1;`;
    expect(endpointMethods(source)).toEqual(['GET', 'POST', 'DELETE', 'fallback']);
    expect(endpointMethods('')).toEqual([]);
  });

  it('are made at an address under /api/, in plain lower-case parts', () => {
    expect(newEndpointRoute('search')).toBe('/api/search');
    expect(newEndpointRoute('/api/search/')).toBe('/api/search');
    expect(newEndpointRoute('/posts/latest')).toBe('/api/posts/latest');
    expect(newEndpointRoute('')).toBeNull();
    expect(newEndpointRoute('/api/Search')).toBeNull();
    expect(newEndpointRoute('/api/[id]')).toBeNull();
    expect(newEndpointRoute('/api/a b')).toBeNull();
    expect(newEndpointProblem('/contact')).toContain('/api/');
    expect(newEndpointProblem('/api/')).toContain('Name the endpoint');
    expect(newEndpointProblem('/api/..')).toContain('cannot be part');
    expect(newEndpointProblem('/api/a/b/c/d/e/f/g')).toContain('at most 6');
    expect(endpointFileFor('/api/search', 'ts')).toBe('src/routes/api/search/+server.ts');
  });

  it('start with a GET and a POST in either language', () => {
    expect(endpointMethods(endpointStarter('/api/search', 'ts'))).toEqual(['GET', 'POST']);
    expect(endpointStarter('/api/search', 'ts')).toContain("import type { RequestHandler } from './$types';");
    expect(endpointStarter('/api/search', 'js')).not.toContain('RequestHandler');
  });
});

describe('the tester’s request and answer', () => {
  it('reads headers typed one per line, leaving out lines that are not one', () => {
    expect(parseHeaderLines('content-type: application/json\n\nAuthorization:  Bearer a:b \nnot a header\n: empty name')).toEqual([
      ['content-type', 'application/json'],
      ['Authorization', 'Bearer a:b']
    ]);
  });

  it('lays out a JSON answer, and shows anything else as it came', () => {
    expect(shownBody('{"a":[1,2]}', [['content-type', 'application/json; charset=utf-8']])).toEqual({ text: '{\n  "a": [\n    1,\n    2\n  ]\n}', json: true });
    expect(shownBody('[1]', [])).toEqual({ text: '[\n  1\n]', json: true });
    expect(shownBody('{not json', [['content-type', 'application/json']])).toEqual({ text: '{not json', json: false });
    expect(shownBody('<p>hi</p>', [['content-type', 'text/html']])).toEqual({ text: '<p>hi</p>', json: false });
  });
});

describe('endpoints on disk', () => {
  it('lists the developer’s endpoints by route, never one the generator lists as its own, nor one in a hidden folder or through a link', async () => {
    const dir = temp();
    write(dir, 'src/routes/api/search/+server.ts', 'export const GET = () => new Response("x");');
    write(dir, 'src/routes/(shop)/api/cart/[id]/+server.js', 'export function GET() {}\nexport function POST() {}');
    write(dir, 'src/routes/about/+page.svelte', '<h1>About</h1>');
    write(dir, 'src/routes/.hidden/+server.js', 'export function GET() {}');
    write(dir, 'src/routes/generated/+server.js', 'export function GET() {}');
    write(dir, 'siteorigin/generated-manifest.json', JSON.stringify({ files: { 'src/routes/generated/+server.js': 'abc' } }));
    const elsewhere = temp();
    write(elsewhere, 'api/+server.js', 'export function GET() {}');
    symlinkSync(elsewhere, join(dir, 'src/routes/linked'));
    expect(await listEndpoints(dir)).toEqual([
      { file: 'src/routes/(shop)/api/cart/[id]/+server.js', route: '/api/cart/[id]', language: 'js', methods: ['GET', 'POST'] },
      { file: 'src/routes/api/search/+server.ts', route: '/api/search', language: 'ts', methods: ['GET'] }
    ]);
    expect(await listEndpoints(temp())).toEqual([]);
  });

  it('reads and saves an endpoint while it holds what was read, and calls a change made meanwhile a conflict', async () => {
    const dir = temp();
    const file = 'src/routes/api/search/+server.ts';
    write(dir, file, 'export const GET = () => new Response("one");\n');
    const read = await readEndpoint(dir, file);
    if (!read.ok) throw new Error(read.message);
    expect(read.hash).toBe(endpointHash(read.text));
    const saved = await saveEndpoint(dir, file, 'export const GET = () => new Response("two");\nexport const POST = () => new Response("ok");\n', read.hash, open);
    expect(saved).toMatchObject({ ok: true, endpoint: { file, route: '/api/search', methods: ['GET', 'POST'] } });
    expect(readFileSync(join(dir, file), 'utf8')).toContain('"two"');
    // Saved again on the hash it was first read with: someone else's change since (here, the save above) is kept.
    const stale = await saveEndpoint(dir, file, 'export const GET = () => new Response("three");\n', read.hash, open);
    expect(stale).toMatchObject({ ok: false, conflict: true });
    expect(readFileSync(join(dir, file), 'utf8')).toContain('"two"');
    rmSync(join(dir, file));
    expect(await saveEndpoint(dir, file, 'x', read.hash, open)).toMatchObject({ ok: false, conflict: true, message: expect.stringContaining('removed') });
  });

  it('writes nothing when the project is no longer this app’s to write', async () => {
    const dir = temp();
    const file = 'src/routes/api/a/+server.js';
    write(dir, file, 'one');
    const shut = async () => false;
    expect(await saveEndpoint(dir, file, 'two', endpointHash('one'), shut)).toMatchObject({ ok: false });
    expect(readFileSync(join(dir, file), 'utf8')).toBe('one');
    expect(await createEndpoint(dir, '/api/b', 'js', shut)).toMatchObject({ ok: false });
  });

  it('refuses what is not an endpoint of the developer’s, and anything reached through a link', async () => {
    const dir = temp();
    write(dir, 'src/routes/+page.svelte', '<h1>Home</h1>');
    expect(await readEndpoint(dir, 'src/routes/+page.svelte')).toMatchObject({ ok: false });
    expect(await readEndpoint(dir, '../outside/+server.js')).toMatchObject({ ok: false });
    write(dir, 'siteorigin/generated-manifest.json', JSON.stringify({ files: { 'src/routes/g/+server.js': 'x' } }));
    write(dir, 'src/routes/g/+server.js', 'x');
    expect(await readEndpoint(dir, 'src/routes/g/+server.js')).toMatchObject({ ok: false, message: expect.stringContaining('SiteOrigin Builder’s own') });
    const elsewhere = temp();
    write(elsewhere, '+server.js', 'secret');
    mkdirSync(join(dir, 'src/routes/api'), { recursive: true });
    symlinkSync(join(elsewhere, '+server.js'), join(dir, 'src/routes/api/+server.js'));
    expect(await readEndpoint(dir, 'src/routes/api/+server.js')).toMatchObject({ ok: false, message: expect.stringContaining('link') });
    expect(await saveEndpoint(dir, 'src/routes/api/+server.js', 'changed', endpointHash('secret'), open)).toMatchObject({ ok: false });
    expect(readFileSync(join(elsewhere, '+server.js'), 'utf8')).toBe('secret');
    symlinkSync(elsewhere, join(dir, 'src/routes/api/linked'));
    expect(await createEndpoint(dir, '/api/linked/x', 'js', open)).toMatchObject({ ok: false });
  });

  it('makes a new endpoint with a starter, and never one where the route already has one in either language', async () => {
    const dir = temp();
    const made = await createEndpoint(dir, '/api/search', 'ts', open);
    expect(made).toMatchObject({ ok: true, endpoint: { file: 'src/routes/api/search/+server.ts', route: '/api/search', language: 'ts', methods: ['GET', 'POST'] } });
    if (!made.ok) return;
    expect(readFileSync(join(dir, 'src/routes/api/search/+server.ts'), 'utf8')).toBe(made.text);
    expect(made.hash).toBe(endpointHash(made.text!));
    expect(await createEndpoint(dir, '/api/search', 'js', open)).toMatchObject({ ok: false, message: expect.stringContaining('already has an endpoint') });
    expect(await createEndpoint(dir, '/api/search', 'ts', open)).toMatchObject({ ok: false });
    expect(await createEndpoint(dir, '/contact', 'ts', open)).toMatchObject({ ok: false, message: expect.stringContaining('/api/') });
  });
});
