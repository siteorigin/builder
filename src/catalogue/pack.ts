/**
 * Theme packs: a coherent implementation of the component catalogue with its tokens, base CSS, fonts and AI
 * guidance. A pack is authored in TypeScript (see `createPack` in ./dsl), built into static release files
 * (a `pack.json` manifest beside its font and preview files), and loaded from those files by the app. Loading
 * a pack only reads data: nothing in a release is ever run.
 */
import type { ComponentDefinition, NodeTree, TokenDef } from '@shared/types';
import type { ContrastPair } from '@shared/contrast';

/**
 * Worked examples for the assistant, one per component family (ai-profile, spec §9.4). A unit test runs every
 * example through the real component contract and value normalizers, so a catalogue change cannot leave one stale.
 */
export interface AiExample {
  id: string;
  componentId: string;
  /** Words in a request that make this example relevant. */
  keywords: string[];
  description: string;
  variant?: string;
  /** Options by axis, such as tone and layout together. */
  variants?: Record<string, string>;
  props: Record<string, unknown>;
}

export type FontCategory = 'sans-serif' | 'serif' | 'monospace' | 'display' | 'handwriting';

/** One web font file and the @font-face descriptors it is served with. */
export interface PackFontFace {
  /** The file inside the pack's release, such as `fonts/inter-latin-wght-normal.woff2`. */
  file: string;
  /** A weight or a variable weight range, such as `400` or `100 900`. */
  weight: string;
  style: 'normal' | 'italic';
  /** The characters this file covers, so a browser only downloads the files a page needs. */
  unicodeRange?: string;
  format: 'woff2' | 'woff2-variations';
}

/** A font family a pack ships, so a site can use it without installing anything. */
export interface PackFont {
  /** The CSS family name the faces declare, such as `Inter Variable`. */
  family: string;
  /** The name a person would use, such as `Inter`. */
  name: string;
  category: FontCategory;
  /** A complete font stack, for font tokens. */
  stack: string;
  /** SPDX identifier of the font's licence, which must allow redistribution in exported sites. */
  license: string;
  /** The licence text and copyright notice that travel with the font files. */
  notice: string;
  faces: PackFontFace[];
}

/** Insert thumbnails for one component: the default look, and one per variant option. */
export interface ComponentPreviews {
  /** The file inside the release, such as `previews/hero.split.webp`. */
  default: string;
  /** Axis ID → option ID → file, each drawn with the other axes at their defaults. */
  variants?: Record<string, Record<string, string>>;
}

/** A pack as the app uses it: what a release's `pack.json` holds, plus where it was loaded from. */
export interface ThemePack {
  id: string;
  name: string;
  version: string;
  /** SPDX identifier of the components' licence. */
  license: string;
  description: string;
  tokens: TokenDef[];
  /** The colour tokens the theme sets against each other, so Site styles can say when a pair stops being readable. */
  contrastPairs?: ContrastPair[];
  baseCss: string;
  /** Fonts served from the pack's own files through generated @font-face rules. */
  fonts: PackFont[];
  components: ComponentDefinition[];
  aiProfile: { guidance: string[]; examples?: AiExample[] };
  /**
   * The layout a new collection's entries start with: elements and text only (no placed components), reading the
   * entry through `{ $entry: field }` bindings and styled with the pack's tokens. Without one, Foundation's is used.
   */
  articleTemplate?: NodeTree;
  /** Compatibility fixtures are only offered in development builds. */
  devOnly?: boolean;
  /** Insert thumbnails by component ID, made when the pack was built. */
  previews?: Record<string, ComponentPreviews>;
  /** SHA-256 of the release's `pack.json`, which lists the hash of every other file in it. */
  digest?: string;
  /** Packs shipped with the app, or installed by the person under `userData/packs`. */
  source?: 'bundled' | 'user';
}

/** Everything a pack is made from except its components and built files. */
export type PackMeta = Omit<ThemePack, 'components' | 'previews' | 'digest' | 'source' | 'fonts'> & { fonts: PackFontSource[] };

/**
 * A font as a pack author declares it: the faces come from a stylesheet of @font-face rules whose `src` names
 * local .woff2 files (a Fontsource package's `index.css`, for example), read when the pack is built.
 */
export interface PackFontSource extends Omit<PackFont, 'faces' | 'notice'> {
  /** Module path of the stylesheet, such as `@fontsource-variable/inter/index.css`. */
  css: string;
  /** Module path of the licence file shipped beside it. */
  noticeFile: string;
  /** The script subsets to ship (`latin`, `latin-ext`, ...), by the name in each file (`inter-latin-wght-normal.woff2`); all of them when absent. */
  subsets?: string[];
}

/** An authored pack, ready to be built into release files. */
export interface AuthoredPack extends PackMeta {
  components: ComponentDefinition[];
}

/**
 * IDs of the packs that ship with the app, which an installed pack can never take, even when a release is missing.
 * Listed in the order the app loads them: the first that is not a development fixture is the default theme.
 */
export const BUNDLED_PACK_IDS = ['foundation', 'editorial', 'signal', 'foundation-alt'];

/** The release format this version of the app reads. */
export const PACK_FORMAT = 1;
export const PACK_MANIFEST = 'pack.json';

/** A release's manifest: the pack's data and the size and hash of every file it ships. */
export interface PackManifest extends Omit<ThemePack, 'digest' | 'source'> {
  format: number;
  /** The document schema the component definitions are written in. */
  schemaVersion: number;
  files: Record<string, { size: number; sha256: string }>;
}

/** Pack IDs and component IDs are short, lower-case and safe in file and CSS names. */
export const PACK_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
export const PACK_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** A file in a release: one folder deep, lower-case, no dots or slashes that could leave the pack. */
export const PACK_FILE_RE = /^(fonts|previews)\/[a-z0-9][a-z0-9._-]{0,119}\.(woff2|webp)$/;

/** The file a preview is written to, inside the release. */
export function previewFile(componentId: string, axis?: string, option?: string): string {
  return `previews/${componentId}${axis ? `--${axis}-${option}` : ''}.webp`;
}
