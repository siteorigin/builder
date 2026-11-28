/**
 * Library images, documents and fonts whose files are no longer in the project folder (moved, deleted or never copied
 * along). The library entry and every use of it stay as they are, so the author can locate the file or choose another.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Diagnostic, MissingAssetFiles } from '@shared/api';
import type { AssetRecord, ProjectState } from '@shared/types';
import { assetUsages } from '@engine/apply';
import { DOCUMENT_EXTENSIONS } from '@shared/document-files';

/** A picture or font as the asset importer names it in static/assets/: a slug, eight hash characters, `-480w` for a responsive copy. */
export const IMPORTED_MEDIA_FILE = /^[a-z0-9][a-z0-9-]*-[a-f0-9]{8}(-\d+w)?\.(jpg|png|webp|gif|avif|svg|woff2?)$/;
/** A document as the asset importer names it: a slug and the first eight characters of the SHA-256 of its bytes, which it keeps as they are. */
export const IMPORTED_DOCUMENT_FILE = new RegExp(`^[a-z0-9][a-z0-9-]*-[a-f0-9]{8}\\.(${DOCUMENT_EXTENSIONS.join('|')})$`);

/** What each library image, document or font is missing: its original, and which of the smaller copies it lists (only an image has any). */
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
    if ((a?.kind !== 'image' && a?.kind !== 'document' && a?.kind !== 'font') || typeof a.file !== 'string') continue;
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
 * What a library file is missing, as a sentence says it: missingParts, or for a font its file by name
 * ("its font file (lora-1a2b3c4d.woff2)"), since one family can have several faces whose names differ little.
 */
export function missingFiles(a: AssetRecord | undefined, m: Pick<MissingAssetFiles, 'original' | 'variants'>): string {
  if (a?.kind === 'font' && m.original && typeof a.file === 'string') return `its font file (${a.file.split('/').pop()})`;
  return missingParts(m);
}

/** A library file's name, or what it is when it has none. */
export function libraryName(a: AssetRecord | undefined): string {
  return (typeof a?.name === 'string' && a.name.trim()) || (a?.kind === 'document' ? 'A document' : a?.kind === 'font' ? 'A font' : 'An image');
}

/**
 * One Project health entry per image, document or font with missing files, naming it. One the site uses (for a font,
 * a style or code that names its family) is a problem, one it does not use a warning. The message never mentions the
 * uses themselves, so it reads the same while they change.
 */
export function missingFileDiagnostics(state: ProjectState, missing: MissingAssetFiles[], usages: () => Record<string, number> = () => assetUsages(state)): Diagnostic[] {
  if (!missing.length) return [];
  const used = usages();
  const out: Diagnostic[] = [];
  for (const m of missing) {
    const a = state.assets.assets[m.assetId];
    if (!a) continue;
    const fix =
      a.kind === 'document' ? 'Locate its file in Assets, or link to something else.' : a.kind === 'font' ? 'Locate the file in Assets, or remove the font.' : m.original ? 'Locate the file or choose another image in Assets.' : 'Make the copies again in Assets.';
    out.push({
      severity: used[a.id] ? 'error' : 'warning',
      code: 'ASSET_FILE_MISSING',
      message: `${libraryName(a)} is missing ${missingFiles(a, m)} in the project folder. ${fix}`,
      owner: { kind: 'asset', id: a.id }
    });
  }
  return out;
}
