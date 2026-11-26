// Checks a generated update metadata file before it is published: its version is package.json's, it lists files
// with a url, sha512 and size each, and a Mac feed points at a zip (Squirrel.Mac installs only from a zip; a feed
// pointing at the DMG breaks Mac updates with no error on the client).
//
//   node scripts/release/validate-update-metadata.ts <metadata-path>
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import { isMain } from './feed.ts';

const PACKAGE_JSON = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');

/** The problems with a parsed metadata file, none when it is publishable. */
export function metadataProblems(data: unknown, fileName: string, packageVersion: string): string[] {
  if (data === null || typeof data !== 'object') return ['not a YAML mapping'];
  const d = data as Record<string, unknown>;
  const problems: string[] = [];
  if (d.version !== packageVersion) problems.push(`version mismatch: yml=${String(d.version)} package.json=${packageVersion}`);
  if (!Array.isArray(d.files) || d.files.length === 0) problems.push('files[] is missing or empty, so the updater has nothing to download');
  else {
    for (const f of d.files as Record<string, unknown>[]) {
      if (!f?.url) problems.push('a file entry has no url');
      else {
        if (!f.sha512) problems.push(`no sha512 for ${String(f.url)}`);
        if (typeof f.size !== 'number' || f.size <= 0) problems.push(`missing or invalid size for ${String(f.url)}`);
      }
    }
  }
  if (!d.path) problems.push('top-level path missing');
  else if (basename(fileName).toLowerCase().includes('mac') && !String(d.path).endsWith('.zip')) {
    problems.push(`a macOS feed's path must be a zip (Squirrel.Mac requires one), got ${String(d.path)}`);
  }
  if (!d.sha512) problems.push('top-level sha512 missing');
  if (!d.releaseDate) problems.push('releaseDate missing');
  return problems;
}

if (isMain(import.meta.url)) {
  const [metadataPath] = process.argv.slice(2);
  if (!metadataPath) {
    console.error('Usage: validate-update-metadata.ts <metadata-path>');
    process.exit(1);
  }
  const { version } = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { version: string };
  const data = load(readFileSync(metadataPath, 'utf8')) as { files?: unknown[] } | null;
  const problems = metadataProblems(data, metadataPath, version);
  if (problems.length) {
    for (const p of problems) console.error(`::error file=${metadataPath}::${p}`);
    process.exit(1);
  }
  console.log(`[validate] ${metadataPath}: version=${version}, ${data?.files?.length} file(s), all with sha512 and size`);
}
