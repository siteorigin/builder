/**
 * The formats a library picture's responsive copies are stored in. A copy's format is its file's extension (the
 * importer names every copy), so an asset record lists only each copy's width and file.
 */

export type CopyMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/avif';

/** The extension a copy in each format is stored under. */
export const COPY_EXTENSIONS: Record<CopyMime, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif' };

/** Whether a picture of this type can have responsive copies at all. */
export const isCopyMime = (mime: unknown): mime is CopyMime => typeof mime === 'string' && Object.hasOwn(COPY_EXTENSIONS, mime);

/** The format a copy's file is in, by its extension; null for a file that is no copy's. */
export function copyMime(file: unknown): CopyMime | null {
  const ext = typeof file === 'string' ? /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase() : undefined;
  if (!ext) return null;
  return (Object.keys(COPY_EXTENSIONS) as CopyMime[]).find((m) => COPY_EXTENSIONS[m] === ext) ?? null;
}

/** The formats a page offers before a picture's own, best first: a browser takes the first it can show. */
export const MODERN_FORMATS = ['image/avif', 'image/webp'] as const satisfies readonly CopyMime[];
