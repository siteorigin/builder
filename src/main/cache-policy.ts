/**
 * How a built website asks its host to cache the hashed files every page shares (SvelteKit's /_app/immutable/), read
 * from the files the export delivers (#1488): `_headers`, which Cloudflare Pages and Netlify read, or `vercel.json`'s
 * headers for Vercel. The generator writes neither rule, so any there is the author's own (a `_headers` in the
 * project's static folder, say). What the host does beyond those files (its dashboard's rules) is not known here.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { RedirectHost } from '@shared/types';
import { cacheValueStatus, type CachePolicy } from '@shared/performance';

/** Where the hashed files are, under the website's root. */
export const IMMUTABLE_DIR = '_app/immutable';

const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** A `_headers` address pattern as a regular expression: `*` matches anything, `:name` one part of a path. */
function headersPattern(pattern: string): RegExp {
  let re = '';
  for (const part of pattern.split(/(\*|:[A-Za-z_][A-Za-z0-9_]*)/)) re += part === '*' ? '.*' : part.startsWith(':') && part.length > 1 ? '[^/]+' : escape(part);
  return new RegExp(`^${re}$`);
}

/** A `vercel.json` source as a regular expression, or null for one in a syntax the report does not read. */
function vercelPattern(source: string): RegExp | null {
  let re = '';
  for (const part of source.split(/(\(\.\*\)|:[A-Za-z_][A-Za-z0-9_]*\*|:[A-Za-z_][A-Za-z0-9_]*)/)) {
    if (part === '(.*)' || (part.startsWith(':') && part.endsWith('*'))) re += '.*';
    else if (part.startsWith(':') && part.length > 1) re += '[^/]+';
    else if (/[()*?+[\]{}|\\]/.test(part)) return null;
    else re += escape(part);
  }
  return new RegExp(`^${re}$`);
}

/**
 * The Cache-Control values the `_headers` text gives an address, in its order, or null when a rule that applies takes
 * the header away again (Cloudflare's `! Cache-Control`), which the report does not follow.
 */
export function headersRules(text: string, paths: readonly string[]): string[] | null {
  const values: string[] = [];
  let applies = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      // A rule for another host's address (Cloudflare's absolute ones) is not for these paths.
      const pattern = line.trim();
      applies = pattern.startsWith('/') && paths.some((p) => headersPattern(pattern).test(p));
      continue;
    }
    if (applies && /^\s+!\s*cache-control\s*$/i.test(line)) return null;
    const header = /^\s+([^:]+):\s*(.*)$/.exec(line);
    if (applies && header && header[1].trim().toLowerCase() === 'cache-control') values.push(header[2].trim());
  }
  return values;
}

/** The Cache-Control values a `vercel.json` gives an address, or null when its headers cannot be read. */
export function vercelRules(text: string, paths: readonly string[]): string[] | null {
  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch {
    return null;
  }
  const rules = (config as { headers?: unknown } | null)?.headers;
  if (rules === undefined) return [];
  if (!Array.isArray(rules)) return null;
  const values: string[] = [];
  for (const rule of rules) {
    const r = rule as { source?: unknown; headers?: unknown; has?: unknown; missing?: unknown };
    if (typeof r?.source !== 'string' || !Array.isArray(r.headers)) return null;
    const pattern = vercelPattern(r.source);
    // A rule only some requests get (by header, cookie or query) says nothing certain of a visit.
    if (!pattern || r.has !== undefined || r.missing !== undefined) return null;
    if (!paths.some((p) => pattern.test(p))) continue;
    for (const h of r.headers as Array<{ key?: unknown; value?: unknown }>) if (typeof h?.key === 'string' && h.key.toLowerCase() === 'cache-control' && typeof h.value === 'string') values.push(h.value.trim());
  }
  return values;
}

/** A plain file's text, or null when there is none (or anything but a file at the path). */
async function readPlain(path: string): Promise<string | null> {
  try {
    if (!(await fs.lstat(path)).isFile()) return null;
    return await fs.readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The hashed files of the built website in `out` a rule is looked up for, by their paths under the root
 * ('_app/immutable/…'): its first script and its first stylesheet, since a rule may cover one kind and not the other,
 * or its first file of any kind when it has neither. None when it has no hashed files.
 */
export async function immutableFiles(out: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(join(out, dir), { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) if (e.isFile()) files.push(`${dir}/${e.name}`);
    for (const e of entries) if (e.isDirectory()) await walk(`${dir}/${e.name}`);
  };
  await walk(IMMUTABLE_DIR);
  const first = (ext: string) => files.find((f) => f.endsWith(ext));
  const chosen = [first('.js'), first('.css')].filter((f): f is string => !!f);
  return chosen.length ? chosen : files.slice(0, 1);
}

/** Which caching is the poorest, so a rule that covers only some hashed files says so. */
const RANK: Record<CachePolicy['status'], number> = { none: 0, short: 1, unknown: 2, long: 3 };

/** How the website built in `out` has its host cache its hashed `files` (see immutableFiles): the poorest of them. */
export async function exportCachePolicies(out: string, host: RedirectHost, base: string, files: readonly string[]): Promise<CachePolicy> {
  if (!files.length) return exportCachePolicy(out, host, base, null);
  const all = await Promise.all(files.map((f) => exportCachePolicy(out, host, base, f)));
  return all.reduce((worst, p) => (RANK[p.status] < RANK[worst.status] ? p : worst));
}

/**
 * How the website built in `out` has its host cache `file` (a hashed file's path under the root), for `host`, whose
 * address is under `base` ('' at the root). A rule is matched to the file's address with the base path and without it,
 * since a host serving the folder at its own root reads it without.
 */
export async function exportCachePolicy(out: string, host: RedirectHost, base: string, file: string | null): Promise<CachePolicy> {
  const name = host === 'vercel' ? 'vercel.json' : '_headers';
  const path = file ? `${base}/${file}` : null;
  const none: CachePolicy = { host, file: null, path, value: null, status: 'none' };
  if (!file || !path) return none;
  const text = await readPlain(join(out, name));
  if (text === null) return none;
  const paths = [...new Set([path, `/${file}`])];
  const values = host === 'vercel' ? vercelRules(text, paths) : headersRules(text, paths);
  if (values === null) return { host, file: name, path, value: null, status: 'unknown' };
  if (!values.length) return { ...none, file: name };
  // Two rules that both apply are joined by the host in a way the report cannot be sure of.
  const distinct = [...new Set(values)];
  if (distinct.length > 1) return { host, file: name, path, value: distinct.join(' | '), status: 'unknown' };
  return { host, file: name, path, value: distinct[0], status: cacheValueStatus(distinct[0]) };
}
