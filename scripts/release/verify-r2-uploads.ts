// Checks that every installer the release folder's update metadata lists is reachable on the download domain at its
// full size, before the metadata itself is uploaded. Without it a partial upload or a CDN propagation race would
// publish metadata pointing at a 404 or a truncated file, and electron-updater fails silently on that.
//
//   PUBLISH_URL=https://downloads.siteorigin.com/releases/ UPDATE_METADATA_PREFIX=latest [RELEASE_DIR=release] \
//     node scripts/release/verify-r2-uploads.ts
import { readFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as defaultSleep } from 'node:timers/promises';
import { load } from 'js-yaml';
import { PLATFORMS, isMain, metadataFilename, publishedUrl } from './feed.ts';

// A HEAD that connects but never gets headers would otherwise wait on undici's 300 s headersTimeout, and three such
// attempts outlast the publish job.
export const FETCH_TIMEOUT_MS = 15_000;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type Sleep = (ms: number) => Promise<unknown>;

/** Whether one listed installer is served with HTTP 200 and its exact size: null when it is, otherwise why not. */
export async function verifyFileUrl(
  entry: { url: string; size: number },
  { fetch: fetchImpl, publishUrl, timeoutMs = FETCH_TIMEOUT_MS }: { fetch: Fetch; publishUrl: string; timeoutMs?: number }
): Promise<string | null> {
  const url = publishedUrl(publishUrl, entry.url);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response: Response;
  try {
    // Racing the abort keeps the deadline hard even when the fetch never rejects on abort.
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    // identity: a compressed response would carry the compressed length, or none, instead of the file's size.
    response = await Promise.race([fetchImpl(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal, headers: { 'accept-encoding': 'identity' } }), timedOut]);
  } catch (error) {
    if (controller.signal.aborted) return `request timed out after ${timeoutMs}ms fetching ${url}`;
    return `network error fetching ${url}: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    clearTimeout(timer);
  }
  if (response.status !== 200) return `expected HTTP 200 for ${url}, got ${response.status}`;
  const raw = response.headers.get('content-length');
  if (raw == null) return `missing Content-Length header for ${url}`;
  const length = Number(raw);
  if (!Number.isFinite(length)) return `invalid Content-Length "${raw}" for ${url}`;
  if (length !== entry.size) return `Content-Length mismatch for ${url}: expected ${entry.size}, got ${length}`;
  return null;
}

/** `verifyFileUrl` with up to `maxAttempts` tries, backing off 5 s, then 10 s. */
export async function verifyWithRetries(
  entry: { url: string; size: number },
  options: { fetch: Fetch; publishUrl: string; sleep?: Sleep; maxAttempts?: number; baseDelayMs?: number; timeoutMs?: number }
): Promise<string | null> {
  const { sleep = defaultSleep, maxAttempts = 3, baseDelayMs = 5000, ...rest } = options;
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastError = await verifyFileUrl(entry, rest);
    if (!lastError) return null;
    if (attempt < maxAttempts) await sleep(baseDelayMs * 2 ** (attempt - 1));
  }
  return lastError;
}

/**
 * Every file the release folder uploads, with its size: everything but the metadata, which goes up after this check.
 * That covers what the feed doesn't list too, such as the DMGs people download from the website.
 */
export async function releaseFolderEntries(releaseDir: string): Promise<{ url: string; size: number }[]> {
  const entries: { url: string; size: number }[] = [];
  for (const name of (await readdir(releaseDir)).sort()) {
    if (name.endsWith('.yml')) continue;
    const info = await stat(join(releaseDir, name));
    if (info.isFile()) entries.push({ url: name, size: info.size });
  }
  return entries;
}

/** The metadata files in the release folder for a channel, whichever platforms it holds. */
export async function findMetadataFiles(releaseDir: string, prefix: string): Promise<string[]> {
  const entries = await readdir(releaseDir);
  return PLATFORMS.map((p) => metadataFilename(prefix, p))
    .filter((name) => entries.includes(name))
    .map((name) => join(releaseDir, name));
}

/** Every listed installer in every metadata file, checked: the failures, none when all are reachable. */
export async function verifyAllFiles(options: {
  metadataFiles: string[];
  publishUrl: string;
  fetch?: Fetch;
  sleep?: Sleep;
  maxAttempts?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  log?: (line: string) => void;
}): Promise<{ filePath: string; message: string }[]> {
  const { metadataFiles, publishUrl, fetch: fetchImpl = fetch, log = console.log, ...retry } = options;
  const failures: { filePath: string; message: string }[] = [];
  for (const filePath of metadataFiles) {
    let data: { files?: unknown } | null;
    try {
      data = load(readFileSync(filePath, 'utf8')) as { files?: unknown } | null;
    } catch (error) {
      failures.push({ filePath, message: `failed to read or parse metadata: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    if (!Array.isArray(data?.files) || data.files.length === 0) {
      failures.push({ filePath, message: 'files[] missing or empty' });
      continue;
    }
    for (const entry of data.files as { url?: string; size?: number }[]) {
      if (!entry?.url || !Number.isFinite(entry?.size)) {
        failures.push({ filePath, message: `invalid file entry in metadata: ${JSON.stringify(entry)}` });
        continue;
      }
      const checked = { url: entry.url, size: entry.size! };
      const error = await verifyWithRetries(checked, { fetch: fetchImpl, publishUrl, ...retry });
      if (error) failures.push({ filePath, message: error });
      else log(`[verify] ok ${publishedUrl(publishUrl, checked.url)} (${checked.size} bytes)`);
    }
  }
  return failures;
}

/**
 * The whole check for a release folder: every installer its metadata lists, then every other file it uploads (the
 * DMGs, blockmaps), each served at its full size. The failures, none when the release is fully reachable.
 */
export async function verifyRelease(options: {
  releaseDir: string;
  prefix: string;
  publishUrl: string;
  fetch?: Fetch;
  sleep?: Sleep;
  maxAttempts?: number;
  baseDelayMs?: number;
  log?: (line: string) => void;
}): Promise<{ filePath: string; message: string }[]> {
  const { releaseDir, prefix, publishUrl, fetch: fetchImpl = fetch, log = console.log, ...retry } = options;
  const metadataFiles = await findMetadataFiles(releaseDir, prefix);
  if (!metadataFiles.length) return [{ filePath: releaseDir, message: `No update metadata in ${releaseDir} for the ${prefix} channel` }];
  log(`[verify] ${publishUrl}: checking ${metadataFiles.join(', ')}`);
  const failures = await verifyAllFiles({ metadataFiles, publishUrl, fetch: fetchImpl, log, ...retry });
  const listed = new Set<string | undefined>();
  for (const f of metadataFiles) {
    try {
      for (const e of (load(readFileSync(f, 'utf8')) as { files?: { url?: string }[] } | null)?.files ?? []) listed.add(e.url);
    } catch {
      // verifyAllFiles has reported it.
    }
  }
  for (const entry of (await releaseFolderEntries(releaseDir)).filter((e) => !listed.has(e.url))) {
    const error = await verifyWithRetries(entry, { fetch: fetchImpl, publishUrl, ...retry });
    if (error) failures.push({ filePath: releaseDir, message: error });
    else log(`[verify] ok ${publishedUrl(publishUrl, entry.url)} (${entry.size} bytes)`);
  }
  return failures;
}

if (isMain(import.meta.url)) {
  const publishUrl = process.env.PUBLISH_URL;
  if (!publishUrl) {
    console.error('::error::PUBLISH_URL is required');
    process.exit(1);
  }
  const failures = await verifyRelease({
    publishUrl,
    releaseDir: process.env.RELEASE_DIR ?? 'release',
    prefix: process.env.UPDATE_METADATA_PREFIX ?? 'latest'
  });
  if (failures.length) {
    for (const { filePath, message } of failures) console.error(`::error file=${filePath}::${message}`);
    process.exit(1);
  }
  console.log('[verify] every uploaded file is reachable at its full size');
}
