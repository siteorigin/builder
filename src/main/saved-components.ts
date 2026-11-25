/**
 * The personal component library (#372): components the author saved from any project, kept on this computer in
 * `userData/saved-components/` so every project can bring them in.
 *
 * Each saved component is two files: the component package itself (`{id}.socomponent.json`, the same file Export
 * writes, read back through the package checks when it is used) and a small card beside it (`{id}.card.json`) with
 * what the Insert panel shows, so listing never reads a package, which may hold megabytes of images. A card is only
 * listed while its package is there; the package is written first and removed last, so a crash between the two
 * leaves at most a package no card names, which the next save of the same component replaces.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { SavedInsertPlace } from '@shared/api';
import type { PackagedDefinition } from '@engine/component-package';
import { COMPONENT_PACKAGE_SUFFIX, MAX_PACKAGE_DEFINITIONS } from '@shared/component-package';
import { atomicWrite, removeDurable, sha } from './project/fsutil';

const CARD_SUFFIX = '.card.json';
/** A saved component's ID: also the base of its two file names, so nothing else is ever accepted as one. */
const SAVED_ID = /^sc_[A-Za-z0-9]{8,32}$/;
/** The largest card read: a card is a few hundred bytes, so anything larger isn't one. */
const MAX_CARD_BYTES = 64 * 1024;

/** A saved component, as its card on disk keeps it: what the panel shows, and what it needs to say more. */
export interface SavedCard {
  id: string;
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
const cardPath = (root: string, id: string) => join(root, `${id}${CARD_SUFFIX}`);
/** Where a saved component's package is. Throws for anything that isn't a saved component's ID. */
export function savedPackagePath(root: string, id: string): string {
  if (!isSavedId(id)) throw new Error('That saved component is not in your library.');
  return join(root, `${id}${COMPONENT_PACKAGE_SUFFIX}`);
}

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
  if (!isRecord(c) || c.id !== id || !text(c.name, 80) || !(c.name as string).trim() || !text(c.savedAt, 60)) return null;
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
    name: c.name as string,
    ...(c.description ? { description: c.description as string } : {}),
    role: c.role,
    definitions: definitions as PackagedDefinition[],
    savedAt: c.savedAt as string,
    ...(c.from ? { from: c.from as string } : {}),
    origin: { projectId: origin.projectId as string, definitionId: origin.definitionId as string }
  };
}

/** Every card in the library whose package is still there, damaged ones left out. */
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
    const st = await fs.lstat(cardPath(root, id)).catch(() => null);
    if (!st?.isFile() || st.size > MAX_CARD_BYTES) continue;
    const card = readCard(await fs.readFile(cardPath(root, id), 'utf8').catch(() => ''), id);
    if (!card) continue;
    const pkg = await fs.lstat(savedPackagePath(root, id)).catch(() => null);
    if (pkg?.isFile()) out.push(card);
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
  return (await cards(root)).find((c) => c.id === id) ?? null;
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

/** Changes to the library, one at a time: two saves of one component never interleave their two files. */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn);
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Save a component to the library: a component saved before from the same project replaces its earlier copy (even
 * renamed since), any other is added. The package goes first and its card after it, so the card never names a package
 * that isn't there. Says which it was.
 */
export function saveToLibrary(root: string, input: SaveInput): Promise<{ card: SavedCard; replaced: boolean }> {
  return serial(async () => {
    const id = savedIdFor(input.origin.projectId, input.origin.definitionId);
    const replaced = !!(await fs.lstat(cardPath(root, id)).catch(() => null));
    const card: Card = {
      id,
      name: input.name,
      ...(input.description ? { description: input.description.slice(0, 1000) } : {}),
      role: input.role,
      definitions: input.definitions,
      savedAt: new Date().toISOString(),
      ...(input.from ? { from: input.from.slice(0, 200) } : {}),
      origin: input.origin
    };
    await atomicWrite(savedPackagePath(root, id), input.text);
    await atomicWrite(cardPath(root, id), `${JSON.stringify(card, null, 2)}\n`);
    return { card, replaced };
  });
}

/** Take a component out of the library: its card first, so it is never listed without its package. */
export function removeSaved(root: string, id: string): Promise<boolean> {
  return serial(async () => {
    if (!isSavedId(id)) return false;
    const had = !!(await fs.lstat(cardPath(root, id)).catch(() => null));
    if (!had) {
      await fs.rm(savedPackagePath(root, id), { force: true });
      return false;
    }
    await removeDurable(cardPath(root, id));
    await removeDurable(savedPackagePath(root, id));
    return true;
  });
}

const OWNER_KINDS = new Set(['page', 'shell', 'component', 'template']);
const NODE_REF = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,120}$/;

/** Where the renderer asked a saved component to go, as plain checked data, or null when it isn't a place. */
export function readInsertPlace(v: unknown): SavedInsertPlace | null {
  if (!isRecord(v) || !isRecord(v.owner)) return null;
  const { kind, id } = v.owner;
  if (typeof kind !== 'string' || !OWNER_KINDS.has(kind) || typeof id !== 'string' || !NODE_REF.test(id)) return null;
  if (v.parentId !== null && (typeof v.parentId !== 'string' || !NODE_REF.test(v.parentId))) return null;
  if (v.slot !== undefined && (typeof v.slot !== 'string' || !NODE_REF.test(v.slot))) return null;
  if (v.index !== undefined && (!Number.isInteger(v.index) || (v.index as number) < 0 || (v.index as number) > 100_000)) return null;
  return {
    owner: { kind: kind as SavedInsertPlace['owner']['kind'], id },
    parentId: v.parentId as string | null,
    ...(v.slot !== undefined ? { slot: v.slot as string } : {}),
    ...(v.index !== undefined ? { index: v.index as number } : {})
  };
}
