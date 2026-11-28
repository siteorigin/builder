/**
 * How a built website asks its host to cache its hashed files (src/main/cache-policy.ts, #1488), read from the
 * `_headers` (Cloudflare Pages, Netlify) or `vercel.json` (Vercel) the export delivers: the rule that matches one of
 * its hashed files, with the base path and without it, or none, or rules the report cannot be sure of.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exportCachePolicies, exportCachePolicy, headersRules, immutableFiles, vercelRules } from '../../src/main/cache-policy';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function site(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'so-cache-policy-'));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

const FILE = '_app/immutable/entry/start.a1b2.js';

describe('a _headers file', () => {
  it('gives an address the Cache-Control of every rule whose pattern matches it', () => {
    const text = ['# Hashed files', '/_app/immutable/*', '  Cache-Control: public, max-age=31536000, immutable', '  X-Other: 1', '/about/', '  Cache-Control: no-cache', '/:section/immutable/*', '  cache-control: max-age=60', 'https://example.com/*', '  Cache-Control: no-store'].join('\n');
    expect(headersRules(text, [`/${FILE}`])).toEqual(['public, max-age=31536000, immutable', 'max-age=60']);
    expect(headersRules(text, ['/about/'])).toEqual(['no-cache']);
    expect(headersRules(text, ['/contact/'])).toEqual([]);
  });
});

describe('a vercel.json', () => {
  it('gives an address the Cache-Control of every rule whose source matches it', () => {
    const config = { headers: [{ source: '/_app/immutable/(.*)', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] }, { source: '/:path*', headers: [{ key: 'X-Frame-Options', value: 'DENY' }] }] };
    expect(vercelRules(JSON.stringify(config), [`/${FILE}`])).toEqual(['public, max-age=31536000, immutable']);
    expect(vercelRules(JSON.stringify({ redirects: [] }), [`/${FILE}`])).toEqual([]);
  });

  it('cannot be read when it is not JSON, or a rule is in a syntax the report does not read or applies only to some requests', () => {
    expect(vercelRules('{', [`/${FILE}`])).toBeNull();
    expect(vercelRules(JSON.stringify({ headers: [{ source: '/_app/(immutable|other)/(.*)', headers: [] }] }), [`/${FILE}`])).toBeNull();
    expect(vercelRules(JSON.stringify({ headers: [{ source: '/(.*)', has: [{ type: 'header', key: 'x' }], headers: [] }] }), [`/${FILE}`])).toBeNull();
  });
});

describe('the exported website’s caching', () => {
  it('finds its first hashed script and stylesheet to look the rule up for, any file without them, and none when it has none', async () => {
    expect(await immutableFiles(site({ [FILE]: '', '_app/immutable/chunks/b.js': '', '_app/immutable/assets/deep/app.css': '' }))).toEqual(['_app/immutable/chunks/b.js', '_app/immutable/assets/deep/app.css']);
    expect(await immutableFiles(site({ '_app/immutable/assets/font.woff2': '' }))).toEqual(['_app/immutable/assets/font.woff2']);
    expect(await immutableFiles(site({ 'index.html': '' }))).toEqual([]);
  });

  it('says the poorest caching of its hashed files, so a rule for its styles alone does not pass its scripts', async () => {
    const css = '_app/immutable/assets/app.css';
    const styles = site({ [FILE]: '', [css]: '', _headers: '/_app/immutable/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n' });
    expect(await exportCachePolicies(styles, 'cloudflare', '', [FILE, css])).toMatchObject({ status: 'none', path: `/${FILE}` });
    expect(await exportCachePolicies(styles, 'cloudflare', '', [])).toMatchObject({ status: 'none', path: null });
  });

  it('cannot tell when a rule that applies takes the header away again', async () => {
    const detached = site({ [FILE]: '', _headers: '/_app/*\n  Cache-Control: public, max-age=31536000, immutable\n/_app/immutable/entry/*\n  ! Cache-Control\n' });
    expect(await exportCachePolicy(detached, 'cloudflare', '', FILE)).toMatchObject({ status: 'unknown' });
  });

  it('reads the rule the host’s own file gives that file, with the base path or without it', async () => {
    const headers = site({ [FILE]: '', _headers: '/_app/immutable/*\n  Cache-Control: public, max-age=31536000, immutable\n' });
    expect(await exportCachePolicy(headers, 'cloudflare', '/client', FILE)).toEqual({ host: 'cloudflare', file: '_headers', path: `/client/${FILE}`, value: 'public, max-age=31536000, immutable', status: 'long' });
    const short = site({ [FILE]: '', _headers: '/client/_app/*\n  Cache-Control: max-age=600\n' });
    expect(await exportCachePolicy(short, 'netlify', '/client', FILE)).toMatchObject({ status: 'short', value: 'max-age=600' });
    const vercel = site({ [FILE]: '', 'vercel.json': JSON.stringify({ headers: [{ source: '/_app/immutable/(.*)', headers: [{ key: 'Cache-Control', value: 'max-age=31536000' }] }] }) });
    expect(await exportCachePolicy(vercel, 'vercel', '', FILE)).toMatchObject({ file: 'vercel.json', status: 'long' });
  });

  it('says there is no rule when the host’s file is absent, the other host’s, or has none for the file', async () => {
    const wrong = site({ [FILE]: '', 'vercel.json': JSON.stringify({ headers: [{ source: '/(.*)', headers: [{ key: 'Cache-Control', value: 'immutable' }] }] }) });
    expect(await exportCachePolicy(wrong, 'cloudflare', '', FILE)).toEqual({ host: 'cloudflare', file: null, path: `/${FILE}`, value: null, status: 'none' });
    const other = site({ [FILE]: '', _headers: '/about/\n  Cache-Control: no-cache\n' });
    expect(await exportCachePolicy(other, 'netlify', '', FILE)).toMatchObject({ file: '_headers', status: 'none' });
    expect(await exportCachePolicy(site({}), 'cloudflare', '', null)).toMatchObject({ path: null, status: 'none' });
  });

  it('cannot tell when two rules give the file different values', async () => {
    const both = site({ [FILE]: '', _headers: '/_app/*\n  Cache-Control: max-age=60\n/_app/immutable/*\n  Cache-Control: immutable\n' });
    expect(await exportCachePolicy(both, 'cloudflare', '', FILE)).toMatchObject({ status: 'unknown', value: 'max-age=60 | immutable' });
  });
});
