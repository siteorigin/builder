/**
 * The files of isolated component previews (see @shared/component-preview), in the editor's dev cache of the folder
 * the preview server runs from: the project, or the private copy of one this app may not write to. Each preview's
 * files are made once, under a key of their own, and never change; a changed preview is a new key. Nothing here
 * depends on Electron, so it is unit tested directly.
 */
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { COMPONENT_PREVIEW_ROUTE, ISOLATED_DIR, PREVIEW_KEY, type ComponentPreviewSpec } from '@shared/component-preview';
import type { FileMap } from '@generator/index';
import { safeJoin } from '../project/fsutil';

/** Large enough for a list of sample items with rich text, small enough that a preview never weighs on the editor. */
const MAX_SPEC_CHARS = 200_000;

/** A preview request as the editor sent it, kept only when it is well formed. */
export function previewSpec(v: unknown): ComponentPreviewSpec | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const { definitionId, componentId, variants, props, states } = v as Record<string, unknown>;
  const id = (x: unknown) => x === undefined || (typeof x === 'string' && x.length > 0 && x.length <= 200);
  const record = (x: unknown) => x === undefined || (!!x && typeof x === 'object' && !Array.isArray(x));
  if (!id(definitionId) || !id(componentId) || !record(variants) || !record(props) || !record(states)) return null;
  if (variants && !Object.values(variants).every((o) => typeof o === 'string')) return null;
  // An item state is previewed at the position of an item.
  if (states && !Object.values(states).every((o) => typeof o === 'string' || typeof o === 'boolean' || (Number.isSafeInteger(o) && (o as number) >= 0))) return null;
  try {
    if (JSON.stringify(v).length > MAX_SPEC_CHARS) return null;
  } catch {
    return null;
  }
  const spec: ComponentPreviewSpec = {};
  if (definitionId !== undefined) spec.definitionId = definitionId as string;
  if (componentId !== undefined) spec.componentId = componentId as string;
  if (variants) spec.variants = { ...(variants as Record<string, string>) };
  if (props) spec.props = { ...(props as Record<string, unknown>) };
  if (states) spec.states = { ...(states as Record<string, boolean | string | number>) };
  return spec;
}

/**
 * The folder holding the prepared previews of the preview server running from `root`, by the project's real path,
 * while every folder on the way to it (.siteorigin, cache, dev, isolated) is a real folder or not there yet; null
 * when one is a link or a file. Nothing is ever written or removed through a link planted there.
 */
async function isolatedFolder(root: string): Promise<string | null> {
  let at = await fs.realpath(root);
  for (const segment of ['.siteorigin', 'cache', 'dev', ISOLATED_DIR]) {
    at = join(at, segment);
    const st = await fs.lstat(at).catch(() => null);
    if (st && (st.isSymbolicLink() || !st.isDirectory())) return null;
  }
  return at;
}

/**
 * Write a preview's files under a new key, all at once: the folder only appears under its key once every file is
 * in it, so the preview server never serves part of one. Returns the key and the address the server shows it at.
 */
export async function writeComponentPreview(root: string, files: FileMap): Promise<{ key: string; path: string }> {
  const base = await isolatedFolder(root);
  // The cache must really be the project's: a link planted there must not make the editor write elsewhere.
  if (!base) throw new Error('The editor’s preview cache is not inside the project folder.');
  await fs.mkdir(base, { recursive: true });
  const key = randomBytes(12).toString('hex');
  const draft = await fs.mkdtemp(join(base, '.draft-'));
  try {
    for (const [path, content] of files) {
      const abs = safeJoin(draft, path);
      await fs.mkdir(dirname(abs), { recursive: true });
      await fs.writeFile(abs, content);
    }
    await fs.rename(draft, join(base, key));
  } catch (e) {
    await fs.rm(draft, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
  return { key, path: `${COMPONENT_PREVIEW_ROUTE}${key}/` };
}

/** Remove one preview's files: its folder, or a link left in its place, never what a link leads to. */
export async function removeComponentPreview(root: string, key: string): Promise<void> {
  if (!PREVIEW_KEY.test(key)) return;
  const base = await isolatedFolder(root).catch(() => null);
  if (!base) return;
  const folder = join(base, key);
  const st = await fs.lstat(folder).catch(() => null);
  if (!st) return;
  await fs.rm(folder, { recursive: st.isDirectory() && !st.isSymbolicLink(), force: true });
}

/** Remove every preview's files: left by a preview server that stopped, or by an app that did not close. */
export async function clearComponentPreviews(root: string): Promise<void> {
  let at = await fs.realpath(root).catch(() => null);
  if (!at) return;
  // Only the cache's own folder is cleared: a link on the way, or in its place, is never followed.
  for (const segment of ['.siteorigin', 'cache', 'dev']) {
    at = join(at, segment);
    const st = await fs.lstat(at).catch(() => null);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) return;
  }
  const base = join(at, ISOLATED_DIR);
  const st = await fs.lstat(base).catch(() => null);
  if (!st) return;
  await fs.rm(base, { recursive: st.isDirectory() && !st.isSymbolicLink(), force: true });
}
