/**
 * The pictures an import's posts show. Each reference gets a key while the post is read; afterwards every key is
 * matched to a file inside the chosen folder, or given the reason it has none. Nothing is fetched from the web: a
 * WordPress picture is looked for in a copy of the site's uploads folder beside the export.
 */
import { extname } from 'node:path';
import type { SourceMedia } from './source';
import { MAX_PICTURE_BYTES, PICTURE_EXTENSIONS } from './source';
import { containedFile, safeSegments } from './files';

/**
 * A reference's path segments from the folder's root, read against `dir` (the segments of the folder the post is
 * in): `..` may climb within the chosen folder, never out of it. Null for anything that could lead elsewhere.
 */
export function segmentsWithin(dir: string[], ref: string): string[] | null {
  if (!ref || ref.length > 1024 || /[\\\0]/.test(ref) || /%(2f|5c|00)/i.test(ref)) return null;
  const out = ref.startsWith('/') ? [] : [...dir];
  for (const raw of ref.split('/')) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') {
      if (!out.length) return null;
      out.pop();
      continue;
    }
    const seg = safeSegments(raw)?.[0];
    if (!seg || seg !== decodeOnce(raw)) return null;
    out.push(seg);
  }
  return out.length ? out : null;
}

const decodeOnce = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return '';
  }
};

/** WordPress's resized copy of an upload (`photo-300x200.jpg`): the original is `photo.jpg`. */
const RESIZED = /^(.+)-\d{2,5}x\d{2,5}(\.[A-Za-z0-9]+)$/;

interface Pending {
  media: SourceMedia;
  /** Where to look, from the root, in order. */
  candidates: string[][];
}

export class MediaTable {
  private pending: Pending[] = [];
  private byRef = new Map<string, string>();

  constructor(
    private readonly root: string,
    private readonly realRoot: string,
    /** The old site's origin (https://example.com), for a WordPress export's absolute picture addresses. */
    private readonly siteOrigin?: string
  ) {}

  get items(): SourceMedia[] {
    return this.pending.map((p) => p.media);
  }

  /** The key for a picture `ref` shown by a post in the folder `dir` (segments from the root). */
  key(ref: string, dir: string[] = []): string {
    const id = `${dir.join('/')}\n${ref}`;
    const known = this.byRef.get(id);
    if (known) return known;
    const key = `m${this.pending.length + 1}`;
    this.byRef.set(id, key);
    const media: SourceMedia = { key, ref: ref.slice(0, 500) };
    const where = this.locate(ref.trim(), dir);
    if ('problem' in where) media.problem = where.problem;
    this.pending.push({ media, candidates: 'candidates' in where ? where.candidates : [] });
    return key;
  }

  private locate(ref: string, dir: string[]): { candidates: string[][] } | { problem: string } {
    if (!ref) return { problem: 'it names no file' };
    let path = ref;
    const web = /^(https?:)?\/\//i.test(ref);
    if (web) {
      let url: URL;
      try {
        url = new URL(ref.startsWith('//') ? `https:${ref}` : ref);
      } catch {
        return { problem: 'its address cannot be read' };
      }
      path = url.pathname;
      const segs = segmentsWithin([], path);
      const at = segs ? segs.findIndex((s, i) => s === 'wp-content' && segs[i + 1] === 'uploads') : -1;
      if (segs && at >= 0) return { candidates: uploads(segs.slice(at + 2)) };
      if (!this.siteOrigin || url.origin !== this.siteOrigin) return { problem: `it is on the web (${url.host}), and only pictures in the chosen folder are imported` };
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) return { problem: 'it is not a file in the chosen folder' };
    const segs = segmentsWithin(dir, path.split(/[?#]/)[0]);
    if (!segs) return { problem: 'its address leads outside the chosen folder' };
    const at = segs.findIndex((s, i) => s === 'wp-content' && segs[i + 1] === 'uploads');
    if (at >= 0) return { candidates: uploads(segs.slice(at + 2)) };
    // A path from the site's root: the folder itself, or a static site's static/ or public/ folder.
    return { candidates: path.startsWith('/') ? [segs, ['static', ...segs], ['public', ...segs]] : [segs] };
  }

  /** Find each picture's file. */
  async resolve(): Promise<void> {
    for (const p of this.pending) {
      if (p.media.problem || p.media.path) continue;
      let found: string | null = null;
      for (const c of p.candidates) {
        found = await containedFile(this.realRoot, this.root, c, MAX_PICTURE_BYTES);
        if (found) break;
      }
      if (!found) p.media.problem = 'it is not in the chosen folder';
      else if (extname(found).toLowerCase() === '.svg') p.media.problem = 'it is an SVG drawing, which is added in Assets rather than with posts';
      else if (!PICTURE_EXTENSIONS.includes(extname(found).slice(1).toLowerCase())) p.media.problem = 'it is not a picture the library takes (JPEG, PNG, WebP, GIF or AVIF)';
      else p.media.path = found;
    }
  }
}

/** Where a WordPress upload (`2019/03/photo-300x200.jpg`) may be beside the export: the original first. */
function uploads(rel: string[]): string[][] {
  if (!rel.length) return [];
  const name = rel[rel.length - 1];
  const original = RESIZED.exec(name);
  const names = original ? [`${original[1]}${original[2]}`, name] : [name];
  const out: string[][] = [];
  for (const n of names) {
    const r = [...rel.slice(0, -1), n];
    out.push(['uploads', ...r], ['wp-content', 'uploads', ...r], r);
  }
  return out;
}
