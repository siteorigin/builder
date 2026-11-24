/**
 * What the import worker reads from a WordPress export or a Markdown folder: posts in the project's own terms, the
 * pictures they show (found beside the export, never fetched), and what was left out. The main process plans the
 * import from it against the open project (see plan.ts).
 */
import type { RichText } from '@shared/types';

export type SourceKind = 'wordpress' | 'markdown';

/** A category or tag as the source names it, with the ID it had there (a WordPress nicename) when it had one. */
export interface SourceTerm {
  label: string;
  slug?: string;
}

/** A link in a post's text to another post of the same import: its target is the other post's key. */
export const POST_LINK_PREFIX = 'post:';

export interface SourcePost {
  /** Unique within the import: `wp:<post ID>` or `md:<file>`. */
  key: string;
  /** Where it came from, as the report names it: its file, or its title in the export. */
  from: string;
  title: string;
  /** The slug it had, if any; the plan makes one from the title otherwise. */
  slug: string;
  /** YYYY-MM-DD, or null when the source has no date the import can read. */
  date: string | null;
  draft: boolean;
  /** Why a post published at the source arrives as a draft (scheduled, private, password-protected...). */
  draftReason?: string;
  author?: string;
  excerpt?: string;
  categories: SourceTerm[];
  tags: SourceTerm[];
  /** The text: a picture's assetId is a media key, and a link to another imported post goes to `post:<key>`. */
  body: RichText;
  /** The featured picture's media key. */
  featured?: string;
  /** The address it had on the old site, when that was a path a static site can have. */
  oldPath?: string;
  /** What reading it left out or changed, in plain words. */
  notes: string[];
}

/** A picture a post shows: the file found for it inside the chosen folder, or why there is none. */
export interface SourceMedia {
  key: string;
  /** The reference as the post wrote it. */
  ref: string;
  /** The file, absolute, checked to be inside the chosen folder. */
  path?: string;
  problem?: string;
}

export interface ParsedSource {
  kind: SourceKind;
  /** The chosen file or folder, as the author sees it named. */
  label: string;
  /** The folder pictures are looked for in, which nothing read may be outside of. */
  root: string;
  /** That folder's real path when it was read: the import reads its pictures from this very folder, never one moved into its place. */
  realRoot: string;
  /** The old site's address, when the export says. */
  site?: string;
  posts: SourcePost[];
  media: SourceMedia[];
  /** What was not imported at all, in plain words ("3 pages: only posts are imported"). */
  skipped: string[];
}

/** The most posts one import brings. */
export const MAX_IMPORT_POSTS = 1000;
/** The largest export file or Markdown file read, and the most all of a folder's Markdown files may hold. */
export const MAX_EXPORT_BYTES = 64 * 1024 * 1024;
export const MAX_MARKDOWN_FILE_BYTES = 2 * 1024 * 1024;
/** The largest picture imported, as the library takes them. */
export const MAX_PICTURE_BYTES = 25 * 1024 * 1024;
/** Pictures an import brings. SVG drawings are added in Assets, where each is cleaned and checked on its own. */
export const PICTURE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif'];
