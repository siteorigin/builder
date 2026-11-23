/**
 * Library images whose files are no longer in the project folder (moved, deleted or never copied along). The
 * library entry and every use of it stay as they are, so the author can locate the file or choose another image.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Diagnostic, MissingAssetFiles } from '@shared/api';
import type { AssetRecord, ProjectState } from '@shared/types';
import { assetUsages } from '@engine/apply';

/** What each library image is missing: its original, and which of the smaller copies it lists. Fonts are not checked. */
export async function findMissingAssetFiles(projectDir: string, assets: Record<string, AssetRecord>): Promise<MissingAssetFiles[]> {
  // Two images may list the same file: each path is looked at once.
  const seen = new Map<string, Promise<boolean>>();
  const present = (rel: string) => {
    let p = seen.get(rel);
    if (!p) {
      // Only a real file counts, as only real files are exported. A file that cannot be looked at is not
      // reported missing: it may well be there.
      p = fs.lstat(join(projectDir, rel)).then(
        (s) => s.isFile(),
        (e: NodeJS.ErrnoException) => e.code !== 'ENOENT' && e.code !== 'ENOTDIR'
      );
      seen.set(rel, p);
    }
    return p;
  };
  const out: MissingAssetFiles[] = [];
  for (const a of Object.values(assets)) {
    if (a?.kind !== 'image' || typeof a.file !== 'string') continue;
    const original = !(await present(a.file));
    const variants: string[] = [];
    for (const v of a.variants ?? []) if (typeof v?.file === 'string' && !(await present(v.file))) variants.push(v.file);
    if (original || variants.length) out.push({ assetId: a.id, original, variants });
  }
  return out;
}

const copies = (n: number) => (n === 1 ? 'a smaller copy' : `${n} smaller copies`);

/** "its original file and 2 smaller copies", "a smaller copy". */
export function missingParts(m: Pick<MissingAssetFiles, 'original' | 'variants'>): string {
  if (m.original) return m.variants.length ? `its original file and ${copies(m.variants.length)}` : 'its original file';
  return copies(m.variants.length);
}

/**
 * One Project health entry per image with missing files, naming it. An image the site uses is a problem, one it does
 * not use a warning. The message never mentions the uses themselves, so it reads the same while they change.
 */
export function missingFileDiagnostics(state: ProjectState, missing: MissingAssetFiles[]): Diagnostic[] {
  if (!missing.length) return [];
  const used = assetUsages(state);
  const out: Diagnostic[] = [];
  for (const m of missing) {
    const a = state.assets.assets[m.assetId];
    if (!a) continue;
    const name = (typeof a.name === 'string' ? a.name.trim() : '') || 'An image';
    const fix = m.original ? 'Locate the file or choose another image in Assets.' : 'Make the copies again in Assets.';
    out.push({
      severity: used[a.id] ? 'error' : 'warning',
      code: 'ASSET_FILE_MISSING',
      message: `${name} is missing ${missingParts(m)} in the project folder. ${fix}`,
      owner: { kind: 'asset', id: a.id }
    });
  }
  return out;
}
