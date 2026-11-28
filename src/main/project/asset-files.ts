/**
 * Library images, documents and fonts whose files are no longer in the project folder (moved, deleted or never copied
 * along). The library entry and every use of it stay as they are, so the author can locate the file or choose another.
 */
import { constants, promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import type { Diagnostic, MissingAssetFiles } from '@shared/api';
import type { AssetRecord, ProjectState } from '@shared/types';
import { assetUsages } from '@engine/apply';
import { DOCUMENT_EXTENSIONS } from '@shared/document-files';
import { copyMime } from '@shared/picture-formats';
import { heifHasImageData, imageProblem } from './media';

/** A picture or font as the asset importer names it in static/assets/: a slug, eight hash characters, `-480w` for a responsive copy. */
export const IMPORTED_MEDIA_FILE = /^[a-z0-9][a-z0-9-]*-[a-f0-9]{8}(-\d+w)?\.(jpg|png|webp|gif|avif|svg|woff2?)$/;
/** A document as the asset importer names it: a slug and the first eight characters of the SHA-256 of its bytes, which it keeps as they are. */
export const IMPORTED_DOCUMENT_FILE = new RegExp(`^[a-z0-9][a-z0-9-]*-[a-f0-9]{8}\\.(${DOCUMENT_EXTENSIONS.join('|')})$`);

/**
 * What each library image, document or font is missing: its original, and which of the smaller copies it lists (only
 * an image has any) need making again, because they are gone or because they are there but damaged (#1459), which
 * `damaged` names of them.
 */
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
  const broken = new Map<string, Promise<boolean>>();
  const damaged = (rel: string) => {
    let p = broken.get(rel);
    if (!p) broken.set(rel, (p = damagedCopy(join(projectDir, rel))));
    return p;
  };
  const out: MissingAssetFiles[] = [];
  for (const a of Object.values(assets)) {
    if ((a?.kind !== 'image' && a?.kind !== 'document' && a?.kind !== 'font') || typeof a.file !== 'string') continue;
    const original = !(await present(a.file));
    const variants: string[] = [];
    const hurt: string[] = [];
    // A font has no smaller copies: one listed (assets.json edited by hand) is nothing a font could be missing.
    if (a.kind !== 'font')
      for (const v of a.variants ?? []) {
        if (typeof v?.file !== 'string') continue;
        if (!(await present(v.file))) variants.push(v.file);
        // Only a picture's copies are pictures: a copy listed on a document (assets.json edited by hand) is not judged.
        else if (a.kind === 'image' && (await damaged(v.file))) variants.push(v.file), hurt.push(v.file);
      }
    if (original || variants.length) out.push({ assetId: a.id, original, variants, damaged: hurt });
  }
  return out;
}

/** What damagedCopy found of each file, by its path and what lstat says of it: a file that changes is looked at again. */
const copyVerdicts = new Map<string, boolean>();
const COPY_VERDICTS = 20_000;
/** Copies are web-sized: a file this large is not read whole to be judged. */
const COPY_READ_LIMIT = 64 * 1024 * 1024;

/**
 * Whether a smaller copy that is in the project folder cannot be shown: its bytes are not a whole picture in the format
 * its name says (imageProblem), as when it was cut short or replaced. Only formats copies are made in are judged, since
 * only those can be made again; a file that is not a plain file, or cannot be read, is not called damaged.
 */
export async function damagedCopy(path: string): Promise<boolean> {
  const mime = copyMime(path);
  if (!mime) return false;
  // One handle, never through a link, for both what the file is and what it holds: a file put in its place meanwhile is
  // judged as itself.
  const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)).catch(() => null);
  if (!handle) return false;
  try {
    const st = await handle.stat({ bigint: true });
    if (!st.isFile() || st.size > BigInt(COPY_READ_LIMIT)) return false;
    const key = `${path}\0${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
    const known = copyVerdicts.get(key);
    if (known !== undefined) return known;
    // Exactly the size the handle said, never more: a file that grows meanwhile is judged by what it held then.
    const size = Number(st.size);
    const buf = Buffer.alloc(size);
    for (let got = 0; got < size; ) {
      const { bytesRead } = await handle.read(buf, got, size - got, got);
      if (!bytesRead) return false;
      got += bytesRead;
    }
    // A copy cut short just before its image data is still whole box by box.
    const verdict = imageProblem(buf, mime) !== null || (mime === 'image/avif' && !heifHasImageData(buf));
    if (copyVerdicts.size >= COPY_VERDICTS) copyVerdicts.delete(copyVerdicts.keys().next().value!);
    copyVerdicts.set(key, verdict);
    return verdict;
  } catch {
    return false;
  } finally {
    await handle.close().catch(() => undefined);
  }
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

/**
 * What is wrong with a library file's files, as a sentence says it after its name: "is missing its original file", "has
 * a damaged smaller copy (photo-1a2b3c4d-480w.avif)", "is missing a smaller copy and has 2 damaged smaller copies (…)".
 */
export function fileTrouble(a: AssetRecord | undefined, m: Pick<MissingAssetFiles, 'original' | 'variants' | 'damaged'>): string {
  const absent = m.variants.filter((v) => !m.damaged.includes(v));
  const parts: string[] = [];
  if (m.original || absent.length) parts.push(`is missing ${missingFiles(a, { original: m.original, variants: absent })}`);
  if (m.damaged.length) parts.push(`has ${m.damaged.length === 1 ? 'a damaged smaller copy' : `${m.damaged.length} damaged smaller copies`} (${m.damaged.map((f) => basename(f)).join(', ')})`);
  return parts.join(' and ');
}

/** A library file's name, or what it is when it has none. */
export function libraryName(a: AssetRecord | undefined): string {
  return (typeof a?.name === 'string' && a.name.trim()) || (a?.kind === 'document' ? 'A document' : a?.kind === 'font' ? 'A font' : 'An image');
}

/**
 * One Project health entry per image, document or font with missing or damaged files, naming it. One the site uses (for a font,
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
      message: `${libraryName(a)} ${fileTrouble(a, m)} in the project folder. ${fix}`,
      owner: { kind: 'asset', id: a.id }
    });
  }
  return out;
}
