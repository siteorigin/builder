// Checks, after the upload, that the update metadata the download domain serves is the file just published: a CDN
// edge can keep serving a cached 404 (or an older file) after the R2 write succeeds. Fetches the public URL, retrying
// transient failures (5 s, 10 s), and compares version, path, sha512 and every files[] entry with the local copy.
//
//   PUBLISH_URL=... UPDATE_METADATA_PREFIX=latest METADATA_SUFFIX=-mac [RELEASE_DIR=release] \
//     node scripts/release/verify-r2-metadata.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as defaultSleep } from 'node:timers/promises';
import { load } from 'js-yaml';
import { METADATA_SUFFIXES, isMain, publishedUrl } from './feed.ts';

const FETCH_TIMEOUT_MS = 15_000;

interface Metadata {
  version: string;
  path: string;
  sha512: string;
  files: { url?: string; sha512?: string }[];
  releaseDate?: unknown;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type Sleep = (ms: number) => Promise<unknown>;

class TransientError extends Error {
  transient = true;
}

/** A suffix must be one a platform's feed uses: `-mac`, `-linux`, or none (Windows). */
export function validateMetadataSuffix(suffix: string): { ok: true } | { ok: false; error: string } {
  const valid = Object.values(METADATA_SUFFIXES);
  if (valid.includes(suffix)) return { ok: true };
  return { ok: false, error: `Invalid METADATA_SUFFIX "${suffix}". Expected one of: ${valid.map((s) => (s ? `"${s}"` : '""')).join(', ')}.` };
}

/** The local metadata file, which must carry a version, path, sha512 and files. */
export function loadLocalMetadata(releaseDir: string, filename: string): Metadata {
  const filePath = join(releaseDir, filename);
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`failed to read local metadata ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = load(raw);
  } catch (error) {
    throw new Error(`failed to parse local metadata ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== 'object') throw new Error(`${filePath}: expected a YAML mapping`);
  const p = parsed as Record<string, unknown>;
  for (const field of ['version', 'path', 'sha512']) {
    if (typeof p[field] !== 'string') throw new Error(`${filePath}: missing or non-string '${field}' field`);
  }
  if (!Array.isArray(p.files) || p.files.length === 0) throw new Error(`${filePath}: 'files' is missing or empty`);
  return parsed as Metadata;
}

/** The metadata the download domain serves now. A network error or a non-200 is transient; anything else is not. */
export async function fetchRemoteMetadata(url: string, fetchImpl: Fetch = fetch, timeoutMs = FETCH_TIMEOUT_MS): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, { signal: controller.signal });
    } catch (error) {
      throw new TransientError(`network error fetching ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status !== 200) throw new TransientError(`expected HTTP 200 for ${url}, got ${response.status}`);
    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      throw new Error(`failed to read body from ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = load(body);
    } catch (error) {
      throw new Error(`failed to parse YAML from ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (parsed === null || typeof parsed !== 'object') throw new Error(`${url}: expected a YAML mapping`);
    return parsed as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

/** How the served metadata differs from the local copy, or null when it matches. */
export function compareMetadata(local: Metadata, remote: Record<string, unknown>): string | null {
  if (local.version !== remote.version) return `version mismatch: local=${local.version}, remote=${String(remote.version)}`;
  if (local.path !== remote.path) return `path mismatch: local=${local.path}, remote=${String(remote.path)}`;
  if (local.sha512 !== remote.sha512) return `sha512 mismatch for primary artifact (path=${local.path})`;
  if (!Array.isArray(remote.files)) return 'remote files[] is not an array';
  if (local.files.length !== remote.files.length) return `files[] length mismatch: local=${local.files.length}, remote=${remote.files.length}`;
  for (let i = 0; i < local.files.length; i++) {
    const l = local.files[i];
    const r = remote.files[i] as { url?: unknown; sha512?: unknown } | null;
    if (r === null || typeof r !== 'object') return `files[${i}]: remote entry is not an object`;
    if (l.url !== r.url) return `files[${i}].url mismatch: local=${l.url}, remote=${String(r.url)}`;
    if (l.sha512 !== r.sha512) return `files[${i}].sha512 mismatch for ${l.url}`;
  }
  return null;
}

/** One check: ok, or the error and whether a retry may clear it. */
export async function verifyMetadataOnce(
  filename: string,
  publishUrl: string,
  releaseDir: string,
  fetchImpl: Fetch = fetch
): Promise<{ ok: true } | { ok: false; error: string; transient: boolean }> {
  let local: Metadata;
  try {
    local = loadLocalMetadata(releaseDir, filename);
  } catch (error) {
    return { ok: false, error: (error as Error).message, transient: false };
  }
  const url = publishedUrl(publishUrl, filename);
  let remote: Record<string, unknown>;
  try {
    remote = await fetchRemoteMetadata(url, fetchImpl);
  } catch (error) {
    return { ok: false, error: (error as Error).message, transient: error instanceof TransientError };
  }
  const mismatch = compareMetadata(local, remote);
  return mismatch ? { ok: false, error: `content mismatch for ${url}: ${mismatch}`, transient: false } : { ok: true };
}

/** `verifyMetadataOnce`, retrying transient failures: null when verified, otherwise the last error. */
export async function verifyMetadataWithRetries(options: {
  filename: string;
  publishUrl: string;
  releaseDir: string;
  fetch?: Fetch;
  sleep?: Sleep;
  maxAttempts?: number;
  baseDelayMs?: number;
  log?: (line: string) => void;
}): Promise<string | null> {
  const { filename, publishUrl, releaseDir, fetch: fetchImpl = fetch, sleep = defaultSleep, maxAttempts = 3, baseDelayMs = 5000, log = console.log } = options;
  if (!Number.isFinite(maxAttempts) || maxAttempts < 1) return `maxAttempts must be >= 1, got ${maxAttempts}`;
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await verifyMetadataOnce(filename, publishUrl, releaseDir, fetchImpl);
    if (result.ok) {
      log(`[verify-metadata] ${publishedUrl(publishUrl, filename)} verified (attempt ${attempt})`);
      return null;
    }
    lastError = result.error;
    if (!result.transient) {
      log(`[verify-metadata] permanent error, not retrying: ${result.error}`);
      break;
    }
    if (attempt >= maxAttempts) break;
    const delay = baseDelayMs * 2 ** (attempt - 1);
    log(`[verify-metadata] attempt ${attempt}/${maxAttempts} failed: ${result.error}; retrying in ${delay}ms`);
    await sleep(delay);
  }
  return lastError;
}

if (isMain(import.meta.url)) {
  const publishUrl = process.env.PUBLISH_URL;
  const releaseDir = process.env.RELEASE_DIR ?? 'release';
  const prefix = process.env.UPDATE_METADATA_PREFIX;
  const suffix = process.env.METADATA_SUFFIX ?? '';
  if (!publishUrl || !prefix) {
    console.error('::error::PUBLISH_URL and UPDATE_METADATA_PREFIX are required');
    process.exit(1);
  }
  const suffixCheck = validateMetadataSuffix(suffix);
  if (!suffixCheck.ok) {
    console.error(`::error::${suffixCheck.error}`);
    process.exit(1);
  }
  const filename = `${prefix}${suffix}.yml`;
  const error = await verifyMetadataWithRetries({ filename, publishUrl, releaseDir });
  if (error) {
    console.error(`::error file=${filename}::${error}`);
    process.exit(1);
  }
  console.log('[verify-metadata] the served metadata matches the published file');
}
