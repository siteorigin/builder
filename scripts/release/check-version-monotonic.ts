// Blocks a publish whose version isn't strictly greater than the one the live feed advertises. electron-updater
// refuses downgrades by default, so a regressed feed would strand every installed client until a hand-made republish.
//
// Reads the new version from the release folder's metadata (`<channel>-mac.yml`, `<channel>-linux.yml`,
// `<channel>.yml` for Windows), fetches the same file from the feed, and compares. Per platform:
//   - new > live                   -> upload
//   - new == live (same string)    -> already published: skip the upload (a re-tag never rewrites a live release)
//   - new < live                   -> fail
//   - 404 on the feed              -> first release on that channel: upload
//   - any other HTTP or network error, unparsable YAML, a missing version -> fail
// When every checked platform is already live it writes `skip_upload=true` to $GITHUB_OUTPUT, and the publish action
// skips its upload and verify steps.
//
//   UPDATE_METADATA_PREFIX=latest RELEASE_PLATFORMS=mac [RELEASE_DIR=release] node scripts/release/check-version-monotonic.ts
import { appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { load } from 'js-yaml';
import semver from 'semver';
import { CHANNELS, PLATFORMS, PUBLISH_URL, isMain, metadataFilename, publishedUrl, uncached, type Platform } from './feed.ts';

const FETCH_TIMEOUT_MS = 15_000;

/** The version in a parsed metadata file, which must be a valid semver string. */
export function extractVersion(parsed: unknown, label: string): string {
  if (parsed === null || typeof parsed !== 'object') throw new Error(`${label}: expected a YAML mapping with a 'version' field`);
  const raw = (parsed as Record<string, unknown>).version;
  if (raw === undefined || raw === null) throw new Error(`${label}: missing 'version' field`);
  // YAML reads a bare `version: 1` as a number: reject it rather than let coercion pass it as valid.
  if (typeof raw !== 'string') throw new Error(`${label}: 'version' must be a string, got ${typeof raw} (${JSON.stringify(raw)})`);
  if (!semver.valid(raw)) throw new Error(`${label}: '${raw}' is not a valid semver version`);
  return raw;
}

/** The platforms to check: a comma-separated subset of PLATFORMS, or all of them when unset. */
export function resolvePlatforms(raw: string | undefined): { ok: true; platforms: Platform[] } | { ok: false; error: string } {
  const requested = String(raw ?? '')
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (!requested.length) return { ok: true, platforms: [...PLATFORMS] };
  const unknown = requested.filter((p) => !(PLATFORMS as readonly string[]).includes(p));
  if (unknown.length) {
    return { ok: false, error: `RELEASE_PLATFORMS contains unknown platform(s): ${unknown.join(', ')}. Expected a subset of: ${PLATFORMS.join(', ')}.` };
  }
  return { ok: true, platforms: PLATFORMS.filter((p) => requested.includes(p)) };
}

/** A channel is required and must be a known one: a typo would 404 on every feed and pass as a first release. */
export function validatePrefix(prefix: string | undefined): { ok: true } | { ok: false; error: string } {
  if (!prefix) return { ok: false, error: `UPDATE_METADATA_PREFIX is not set; refusing to guess the channel. Set it to one of: ${CHANNELS.join(', ')}.` };
  if (!(CHANNELS as readonly string[]).includes(prefix)) {
    return { ok: false, error: `UPDATE_METADATA_PREFIX='${prefix}' is not a known channel. Expected one of: ${CHANNELS.join(', ')}.` };
  }
  return { ok: true };
}

/**
 * Whether `newVersion` may replace `liveVersion`. The same string is a re-tag of a release already live: skip, don't
 * fail and don't rewrite it. Exact identity, not semver equality: `1.0.0+a` and `1.0.0+b` share precedence but were
 * never both published, so they fall through to the strict check and fail.
 */
export function checkVersionMonotonic(liveVersion: string, newVersion: string): { ok: true; skip?: true } | { ok: false; error: string } {
  if (!semver.valid(liveVersion)) return { ok: false, error: `live version '${liveVersion}' is not valid semver` };
  if (!semver.valid(newVersion)) return { ok: false, error: `new version '${newVersion}' is not valid semver` };
  if (newVersion === liveVersion) return { ok: true, skip: true };
  if (!semver.gt(newVersion, liveVersion)) return { ok: false, error: `new version ${newVersion} is not strictly greater than live ${liveVersion}` };
  return { ok: true };
}

/** Skip the upload only when every checked platform is already live and nothing failed. */
export function shouldSkipUpload(platforms: string[], skipped: string[], failures: string[]): boolean {
  return platforms.length > 0 && failures.length === 0 && skipped.length === platforms.length;
}

/** Tells the publish action whether to skip: a write error fails the gate rather than losing the decision. */
export function writeSkipUploadOutput(skipUpload: boolean): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  appendFileSync(outputPath, `skip_upload=${skipUpload}\n`, 'utf8');
}

/** The version a platform's feed advertises now, or null when the feed has no file for it yet (HTTP 404). */
export async function fetchLiveVersion(
  prefix: string,
  platform: Platform,
  options: { baseUrl?: string; fetch?: typeof fetch; timeoutMs?: number } = {}
): Promise<{ url: string; version: string | null }> {
  const { baseUrl = PUBLISH_URL, fetch: fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS } = options;
  const url = publishedUrl(baseUrl, metadataFilename(prefix, platform));
  // Armed across the body read too: a CDN that sends headers and then stalls fails here, not at the job timeout.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(uncached(url), { signal: controller.signal, headers: { 'cache-control': 'no-cache' } });
    } catch (error) {
      throw new Error(`failed to fetch ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 404) return { url, version: null };
    if (!response.ok) throw new Error(`unexpected HTTP ${response.status} from ${url}`);
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
    return { url, version: extractVersion(parsed, `live ${metadataFilename(prefix, platform)}`) };
  } finally {
    clearTimeout(timer);
  }
}

async function readLocalVersion(releaseDir: string, prefix: string, platform: Platform): Promise<{ filePath: string; version: string }> {
  const filePath = join(releaseDir, metadataFilename(prefix, platform));
  let body: string;
  try {
    body = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new Error(`failed to read local metadata ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = load(body);
  } catch (error) {
    throw new Error(`failed to parse YAML from ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { filePath, version: extractVersion(parsed, `local ${metadataFilename(prefix, platform)}`) };
}

/** Runs the gate: the outcome per platform, the failures, and whether the upload can be skipped. */
export async function runGate(options: {
  prefix: string | undefined;
  platforms: string | undefined;
  releaseDir?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}): Promise<{ failures: string[]; skipUpload: boolean }> {
  const { prefix, releaseDir = 'release', baseUrl, fetch: fetchImpl, log = console.log } = options;
  const prefixCheck = validatePrefix(prefix);
  if (!prefixCheck.ok) return { failures: [prefixCheck.error], skipUpload: false };
  const platformsCheck = resolvePlatforms(options.platforms);
  if (!platformsCheck.ok) return { failures: [platformsCheck.error], skipUpload: false };
  const platforms = platformsCheck.platforms;

  let locals: { filePath: string; version: string }[];
  try {
    locals = await Promise.all(platforms.map((p) => readLocalVersion(releaseDir, prefix!, p)));
  } catch (error) {
    return { failures: [error instanceof Error ? error.message : String(error)], skipUpload: false };
  }
  const newVersion = locals[0].version;
  if (locals.some((l) => l.version !== newVersion)) {
    const summary = locals.map((l, i) => `${platforms[i]}=${l.version} (${l.filePath})`).join(' ');
    return { failures: [`the release folder's metadata files disagree on the new version: ${summary}`], skipUpload: false };
  }

  // Every feed is fetched, so a transient error on one and a real regression on another both show in one run.
  const results = await Promise.allSettled(platforms.map((p) => fetchLiveVersion(prefix!, p, { baseUrl, fetch: fetchImpl })));
  const failures: string[] = [];
  const skipped: string[] = [];
  results.forEach((settled, i) => {
    const platform = platforms[i];
    if (settled.status === 'rejected') {
      failures.push(`${platform}: ${settled.reason instanceof Error ? settled.reason.message : String(settled.reason)}`);
      return;
    }
    const live = settled.value;
    if (live.version === null) {
      log(`[monotonic] ${platform}: no live ${metadataFilename(prefix!, platform)} (HTTP 404): first release on this channel, allowing.`);
      return;
    }
    const result = checkVersionMonotonic(live.version, newVersion);
    if (!result.ok) failures.push(`${platform}: ${result.error} (feed: ${live.url})`);
    else if (result.skip) {
      skipped.push(platform);
      log(`[monotonic] ${platform}: ${newVersion} is already live (${live.url}), so it is not uploaded again.`);
    } else log(`[monotonic] ${platform}: ${newVersion} > ${live.version} (live ${live.url}).`);
  });
  return { failures, skipUpload: shouldSkipUpload(platforms, skipped, failures) };
}

if (isMain(import.meta.url)) {
  const { failures, skipUpload } = await runGate({
    prefix: process.env.UPDATE_METADATA_PREFIX,
    platforms: process.env.RELEASE_PLATFORMS,
    releaseDir: process.env.RELEASE_DIR,
    // The feed the verifiers check after the upload, so all three agree on where the release goes.
    baseUrl: process.env.PUBLISH_URL || undefined
  });
  if (failures.length) {
    console.error(`::error::version-monotonic gate failed:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
  writeSkipUploadOutput(skipUpload);
  console.log(skipUpload ? '[monotonic] already live on every checked platform: skipping the upload.' : '[monotonic] gate passed: uploading.');
}
