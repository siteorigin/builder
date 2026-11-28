/**
 * A portable component package (`.socomponent.json`): one project component, every component it needs, the site
 * styles it uses and the library images it shows, in one file another project can import (#371).
 *
 * The file is plain JSON with the images inside it (base64), so it is one thing to send, and nothing is unpacked to
 * disk to read it. This module is the contract both sides share: the shapes, the limits, and the first, structural
 * check of a file someone else wrote. What the package holds is checked again, as it will land, when it is imported.
 */
import { z } from 'zod';
import type { ComponentDefinition, TextStyleValue, TokenGroup, TokenValue } from './types';

export const COMPONENT_PACKAGE_FORMAT = 'siteorigin.component';
/** The package format. A newer one is refused by name, so an older app never misreads it. */
export const COMPONENT_PACKAGE_VERSION = 1;
/** What a package file's name ends with. */
export const COMPONENT_PACKAGE_SUFFIX = '.socomponent.json';
/** The largest package file read or written. */
export const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;
/** The largest image a package carries: the library's own limit. */
export const MAX_PACKAGE_IMAGE_BYTES = 25 * 1024 * 1024;
/** All of a package's images together. */
export const MAX_PACKAGE_IMAGES_BYTES = 40 * 1024 * 1024;
/** Components one package carries: the component and everything it places or imports. */
export const MAX_PACKAGE_DEFINITIONS = 60;
const MAX_PACKAGE_TOKENS = 400;
const MAX_PACKAGE_IMAGES = 100;
/** How deep a package's JSON may nest. Real definitions stay far shallower; this only stops a runaway file. */
const MAX_DEPTH = 64;

/** Images a package may carry: the pictures the library shows (fonts and documents stay with their project). */
export const PACKAGE_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/svg+xml'] as const;
export type PackageImageMime = (typeof PACKAGE_IMAGE_MIMES)[number];
/** The extension an image of each type is stored with. */
export const PACKAGE_IMAGE_EXTENSIONS: Record<PackageImageMime, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
  'image/svg+xml': '.svg'
};

/** One site style the package's components use. */
export interface PackageToken {
  id: string;
  group: TokenGroup;
  label: string;
  description?: string;
  /** One of the site's own styles, rather than one its theme defines. */
  custom: boolean;
  /** Its value in the project it came from: its own, or `{ token }` following another style the package also carries. */
  value: TokenValue;
  /** Its value with every link followed (a text style's font included), so a project without it can make one that looks the same. */
  resolved: string | TextStyleValue;
  /**
   * A colour's look in the dark palette of the project it came from, with every link followed, as `resolved` is: for a
   * style of the site's own, when it has a dark colour of its own there; for a theme style, when it differs from its
   * light one. Absent: it shows in dark what its light value leads to, as it will where it lands.
   */
  dark?: string;
}

/** One library image the package's components show. */
export interface PackageImage {
  /** Its asset ID in the project it came from, as the definitions name it. */
  id: string;
  name: string;
  mime: PackageImageMime;
  /** SHA-256 of the bytes, as the library records it. */
  hash: string;
  /** The image's bytes, base64. */
  data: string;
  description?: string;
  altSuggestion?: string;
}

export interface ComponentPackage {
  format: typeof COMPONENT_PACKAGE_FORMAT;
  version: number;
  /** The app that wrote it ("SiteOrigin Builder 0.1.0"), for people reading the file. */
  app?: string;
  exportedAt?: string;
  /** The component the package is for; the other definitions are what it needs. */
  rootId: string;
  /** Each in the document format it was saved in (its own `schemaVersion`). */
  definitions: ComponentDefinition[];
  tokens: PackageToken[];
  images: PackageImage[];
}

/** The names a package may never use as keys, anywhere: they would reach object prototypes. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Why a parsed value is not plain data a package may hold: a reserved key, or nesting deeper than any definition. */
function shapeProblem(v: unknown, depth = 0): string | null {
  if (depth > MAX_DEPTH) return 'it nests deeper than any component does';
  if (Array.isArray(v)) {
    for (const x of v) {
      const p = shapeProblem(x, depth + 1);
      if (p) return p;
    }
    return null;
  }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (FORBIDDEN_KEYS.has(k)) return `it uses the reserved name "${k}"`;
      const p = shapeProblem(x, depth + 1);
      if (p) return p;
    }
  }
  return null;
}

const ID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/);
const TOKEN_ID = z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/).max(120);

/**
 * The parts of a definition reading a package relies on. Older documents may be shaped differently elsewhere: they are
 * brought to the current format first, and what they hold is checked when they are imported.
 */
const definition = z
  .object({
    schemaVersion: z.number().int().positive(),
    id: ID,
    componentId: z.string().max(160),
    kind: z.enum(['managed', 'code']),
    owner: z.enum(['theme', 'project']),
    name: z.string().min(1).max(80).refine((n) => n.trim().length > 0, 'a component needs a name'),
    description: z.string().max(1000).optional(),
    properties: z.record(z.string(), z.object({ type: z.string() }).loose()),
    parts: z.record(z.string(), z.object({ nodeId: z.string() }).loose()).optional(),
    tree: z.object({ rootIds: z.array(z.string()), nodes: z.record(z.string(), z.object({ id: z.string(), kind: z.string() }).loose()) }).optional(),
    source: z.string().max(60_000).optional(),
    sourcePath: z.string().max(200).optional(),
    dependencies: z.array(z.string()).max(MAX_PACKAGE_DEFINITIONS).optional()
  })
  .loose();

const packageSchema = z.object({
  format: z.literal(COMPONENT_PACKAGE_FORMAT),
  version: z.number().int().positive(),
  app: z.string().max(200).optional(),
  exportedAt: z.string().max(60).optional(),
  rootId: ID,
  definitions: z.array(definition).min(1).max(MAX_PACKAGE_DEFINITIONS),
  tokens: z
    .array(
      z.object({
        id: TOKEN_ID,
        group: z.enum(['color', 'font', 'text', 'space', 'container', 'radius', 'shadow', 'border']),
        label: z.string().min(1).max(80).refine((n) => n.trim().length > 0, 'a style needs a name'),
        description: z.string().max(200).optional(),
        custom: z.boolean(),
        value: z.unknown(),
        resolved: z.unknown(),
        dark: z.unknown().optional()
      })
    )
    .max(MAX_PACKAGE_TOKENS),
  images: z
    .array(
      z.object({
        id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/),
        name: z.string().max(200),
        mime: z.enum(PACKAGE_IMAGE_MIMES),
        hash: z.string().regex(/^[0-9a-f]{64}$/),
        // Base64 of at most the largest image.
        data: z
          .string()
          .max(Math.ceil(MAX_PACKAGE_IMAGE_BYTES / 3) * 4)
          .regex(/^[A-Za-z0-9+/]*={0,2}$/),
        description: z.string().max(2000).optional(),
        altSuggestion: z.string().max(2000).optional()
      })
    )
    .max(MAX_PACKAGE_IMAGES)
});

/** A package file that cannot be imported, with the reason in words the author can act on. */
export class PackageError extends Error {}

const refuse = (why: string): never => {
  throw new PackageError(`This component package can't be imported: ${why}`);
};

/**
 * Read a package file's text, checking its structure: the format and version, the shapes the importer relies on, and
 * that every name it uses is unique and plain. Throws a PackageError saying what is wrong. The definitions come back
 * in the document format they were saved in.
 */
export function decodeComponentPackage(text: string): ComponentPackage {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    refuse('it is not a complete JSON file. If it was downloaded or copied, it may be incomplete: get the file again.');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw as { format?: unknown }).format !== COMPONENT_PACKAGE_FORMAT)
    refuse('it is not a SiteOrigin Builder component package.');
  const version = (raw as { version?: unknown }).version;
  if (typeof version === 'number' && version > COMPONENT_PACKAGE_VERSION) refuse('it was made by a newer version of SiteOrigin Builder. Update the app to import it.');
  const shape = shapeProblem(raw);
  if (shape) refuse(`${shape}.`);
  const parsed = packageSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    refuse(`part of it is damaged (${issue.path.join('.') || 'the file'}: ${issue.message}).`);
  }
  // The file's own objects, as checked: a parse would reorder their keys, and a theme component is recognised by its
  // exact content.
  const pkg = raw as ComponentPackage;
  const unique = (ids: string[], what: string) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) refuse(`it lists the ${what} "${id}" twice.`);
      seen.add(id);
    }
  };
  unique(pkg.definitions.map((d) => d.id), 'component');
  unique(pkg.tokens.map((t) => t.id), 'site style');
  unique(pkg.images.map((i) => i.id), 'image');
  if (!pkg.definitions.some((d) => d.id === pkg.rootId)) refuse('the component it is for is missing from it.');
  let bytes = 0;
  for (const img of pkg.images) bytes += Math.floor((img.data.length * 3) / 4) - (img.data.endsWith('==') ? 2 : img.data.endsWith('=') ? 1 : 0);
  if (bytes > MAX_PACKAGE_IMAGES_BYTES) refuse(`its images add up to more than ${MAX_PACKAGE_IMAGES_BYTES / 1024 / 1024} MB.`);
  return pkg;
}

/** The file name a package of a component is offered under: "Pricing table.socomponent.json". */
export function packageFileName(name: string): string {
  const base = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Component';
  return `${base}${COMPONENT_PACKAGE_SUFFIX}`;
}
