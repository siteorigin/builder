/**
 * The personal component library (#372): components the author saved from any project, kept on this computer in
 * `userData/saved-components/` so every project can bring them in.
 *
 * Each saved component is a card (`{id}.card.json`) with what the Insert panel shows, and the package it names: the
 * same file Export writes, read back through the package checks when it is used, and never changed once written, so it
 * is stored under its content's digest (`{id}.{digest}.socomponent.json`). Listing reads cards alone, never a package,
 * which may hold megabytes of images. Saving again writes the new package beside the old one and then the card that
 * names it, and only then removes the old package: whatever happens part way, the card names a complete package, the
 * one it describes. Removing takes the card first. A package no card names is swept when its component is next saved or
 * removed. Inserting or removing names the generation the panel showed, so a menu opened before a newer save never
 * acts on that save.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { SavedInsertPlace } from '@shared/api';
import { validateOperation } from '@shared/ops';
import type { PackagedDefinition } from '@engine/component-package';
import { COMPONENT_PACKAGE_SUFFIX, MAX_PACKAGE_DEFINITIONS } from '@shared/component-package';
import { readRegularFile } from './packs/files';
import { atomicWrite, removeDurable, sha } from './project/fsutil';

const CARD_SUFFIX = '.card.json';
/** A saved component's ID: also the start of its file names, so nothing else is ever accepted as one. */
const SAVED_ID = /^sc_[A-Za-z0-9]{8,32}$/;
/** A package generation's digest: the start of its content's SHA-256. */
const DIGEST = /^[a-f0-9]{24}$/;
/** The largest card read or written: room for a package's every component and what each renders. */
const MAX_CARD_BYTES = 1024 * 1024;

/** A saved component, as its card on disk keeps it: what the panel shows, and what it needs to say more. */
export interface SavedCard {
  id: string;
  /** The package generation the card describes (see packagePath). */
  digest: string;
  name: string;
  description?: string;
  /** How it goes into a page: as one of the page's sections, or as an element inside a layout. */
  role: 'section' | 'element';
  /** Its package's components, as much as is needed to tell whether it brings code into a project (see codeBrought). */
  definitions: PackagedDefinition[];
  savedAt: string;
  /** The name of the project it was saved from. */
  from?: string;
  /** The project and component it was saved from: saving the same one again replaces it rather than adding another. */
  origin: { projectId: string; definitionId: string };
}
type Card = SavedCard;

export const isSavedId = (id: unknown): id is string => typeof id === 'string' && SAVED_ID.test(id);
export const isDigest = (d: unknown): d is string => typeof d === 'string' && DIGEST.test(d);
const cardPath = (root: string, id: string) => join(root, `${id}${CARD_SUFFIX}`);
/** Where the package generation `digest` of saved component `id` is. Throws for anything that isn't one. */
export function packagePath(root: string, id: string, digest: string): string {
  if (!isSavedId(id) || !isDigest(digest)) throw new Error('That saved component is not in your library.');
  return join(root, `${id}.${digest}${COMPONENT_PACKAGE_SUFFIX}`);
}
/** The package a card names. */
export const savedPackagePath = (root: string, card: Pick<SavedCard, 'id' | 'digest'>): string => packagePath(root, card.id, card.digest);

const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** One packaged component's summary as a card keeps it, or null when it isn't one. */
function readDefinition(v: unknown): PackagedDefinition | null {
  if (!isRecord(v) || !text(v.id, 200) || !text(v.name, 200) || !text(v.hash, 200)) return null;
  if ((v.owner !== 'theme' && v.owner !== 'project') || (v.kind !== 'managed' && v.kind !== 'code')) return null;
  if (!Array.isArray(v.needs) || v.needs.length > MAX_PACKAGE_DEFINITIONS || !v.needs.every((n) => text(n, 200))) return null;
  return { id: v.id as string, owner: v.owner, kind: v.kind, name: v.name as string, hash: v.hash as string, needs: [...(v.needs as string[])] };
}

/** A card read from disk, or null when it is damaged or not one: a hand-edited file never breaks the list. */
function readCard(raw: string, id: string): Card | null {
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(c) || c.id !== id || !isDigest(c.digest) || !text(c.name, 80) || !(c.name as string).trim() || !text(c.savedAt, 60)) return null;
  if (c.role !== 'section' && c.role !== 'element') return null;
  if (!Array.isArray(c.definitions) || !c.definitions.length || c.definitions.length > MAX_PACKAGE_DEFINITIONS) return null;
  const definitions = c.definitions.map(readDefinition);
  if (definitions.some((d) => !d)) return null;
  const origin = c.origin;
  if (!isRecord(origin) || !text(origin.projectId, 200) || !text(origin.definitionId, 200)) return null;
  if (c.description !== undefined && !text(c.description, 1000)) return null;
  if (c.from !== undefined && !text(c.from, 200)) return null;
  return {
    id,
    digest: c.digest,
    name: c.name as string,
    ...(c.description ? { description: c.description as string } : {}),
    role: c.role,
    definitions: definitions as PackagedDefinition[],
    savedAt: c.savedAt as string,
    ...(c.from ? { from: c.from as string } : {}),
    origin: { projectId: origin.projectId as string, definitionId: origin.definitionId as string }
  };
}

/** The card of saved component `id`, read as a plain file of bounded size, or null when there is none to use. */
async function cardOf(root: string, id: string): Promise<Card | null> {
  const buf = await readRegularFile(cardPath(root, id), MAX_CARD_BYTES).catch(() => null);
  return buf ? readCard(buf.toString('utf8'), id) : null;
}

/** Whether the package a card names is there, as a plain file. */
const hasPackage = async (root: string, card: Card) => !!(await fs.lstat(savedPackagePath(root, card)).catch(() => null))?.isFile();

/** Every card in the library whose package is there, damaged ones left out. */
async function cards(root: string): Promise<Card[]> {
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return [];
  }
  const out: Card[] = [];
  for (const name of names) {
    if (!name.endsWith(CARD_SUFFIX)) continue;
    const id = name.slice(0, -CARD_SUFFIX.length);
    if (!isSavedId(id)) continue;
    const card = await cardOf(root, id);
    if (card && (await hasPackage(root, card))) out.push(card);
  }
  return out;
}

const byName = (a: Card, b: Card) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || a.savedAt.localeCompare(b.savedAt);

/** The saved components, by name. */
export async function listSaved(root: string): Promise<SavedCard[]> {
  return (await cards(root)).sort(byName);
}

/** One saved component, or null once it has gone from the library. */
export async function findSaved(root: string, id: string): Promise<SavedCard | null> {
  if (!isSavedId(id)) return null;
  const card = await cardOf(root, id);
  return card && (await hasPackage(root, card)) ? card : null;
}

/** The ID a component saved from a project has, whenever it is saved: saving it again replaces the earlier copy. */
export const savedIdFor = (projectId: string, definitionId: string): string => `sc_${sha(JSON.stringify([projectId, definitionId])).slice(0, 24)}`;

/** What saving a component writes (see saveToLibrary). */
export interface SaveInput {
  /** The package's text, as buildComponentPackage made it. */
  text: string;
  name: string;
  description?: string;
  role: 'section' | 'element';
  definitions: PackagedDefinition[];
  /** The project's name, for the row's line. */
  from?: string;
  origin: { projectId: string; definitionId: string };
}

/** Changes to the library, one at a time: two saves of one component never interleave their files. */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn);
  queue = run.catch(() => undefined);
  return run;
}

/** Remove the package generations of saved component `id` other than `keep` (none kept when it is null). */
async function sweep(root: string, id: string, keep: string | null): Promise<void> {
  const names = await fs.readdir(root).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.startsWith(`${id}.`) || !name.endsWith(COMPONENT_PACKAGE_SUFFIX)) continue;
    const digest = name.slice(id.length + 1, -COMPONENT_PACKAGE_SUFFIX.length);
    if (isDigest(digest) && digest !== keep) await fs.rm(join(root, name), { force: true });
  }
}

/**
 * Save a component to the library: a component saved before from the same project replaces its earlier copy (even
 * renamed since), any other is added. The new package goes in beside the old, then the card that names it, and only
 * then is the old package removed. A card this app couldn't read back is refused before anything is replaced. Says
 * which it was.
 */
export function saveToLibrary(root: string, input: SaveInput): Promise<{ card: SavedCard; replaced: boolean }> {
  return serial(async () => {
    const id = savedIdFor(input.origin.projectId, input.origin.definitionId);
    const replaced = !!(await cardOf(root, id));
    const card: Card = {
      id,
      digest: sha(input.text).slice(0, 24),
      name: input.name,
      ...(input.description ? { description: input.description.slice(0, 1000) } : {}),
      role: input.role,
      definitions: input.definitions,
      savedAt: new Date().toISOString(),
      ...(input.from ? { from: input.from.slice(0, 200) } : {}),
      origin: input.origin
    };
    const cardText = `${JSON.stringify(card, null, 2)}\n`;
    if (Buffer.byteLength(cardText) > MAX_CARD_BYTES || !readCard(cardText, id)) throw new Error('it needs more components than one saved component can list.');
    await atomicWrite(savedPackagePath(root, card), input.text);
    await atomicWrite(cardPath(root, id), cardText);
    await sweep(root, id, card.digest);
    return { card, replaced };
  });
}

/**
 * Take a component out of the library: its card first, so it is never listed without its package, then every package
 * it had. With `digest`, only while the card still names that generation: a newer save stays. Says what happened.
 */
export function removeSaved(root: string, id: string, digest?: string): Promise<'removed' | 'changed' | 'gone'> {
  return serial(async () => {
    if (!isSavedId(id)) return 'gone';
    const card = await cardOf(root, id);
    if (!card) {
      await sweep(root, id, null);
      return 'gone';
    }
    if (digest !== undefined && card.digest !== digest) return 'changed';
    await removeDurable(cardPath(root, id));
    await sweep(root, id, null);
    return 'removed';
  });
}

/**
 * Where the renderer asked a saved component to go, checked as the place of an ordinary insert is, or null when it
 * isn't one. Never the shared header or footer: Insert never puts a component there.
 */
export function readInsertPlace(v: unknown): SavedInsertPlace | null {
  if (!isRecord(v) || !isRecord(v.owner) || v.owner.kind === 'shell' || (v.parentId !== null && typeof v.parentId !== 'string')) return null;
  const checked = validateOperation({ type: 'node.insert', owner: v.owner, parentId: v.parentId, slot: v.slot, index: v.index, definitionId: 'saved' });
  if (!checked.ok || checked.op.type !== 'node.insert') return null;
  const { owner, slot, index } = checked.op;
  return {
    owner: { kind: owner.kind, id: owner.id },
    parentId: v.parentId as string | null,
    ...(slot !== undefined ? { slot } : {}),
    ...(index !== undefined ? { index } : {})
  };
}
