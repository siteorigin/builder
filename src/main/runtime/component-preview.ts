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
import { realFileInside } from '../../runtime/policy';

/** The folder holding every prepared preview of the preview server running from `root`. */
export const isolatedRoot = (root: string) => join(root, '.siteorigin', 'cache', 'dev', ISOLATED_DIR);

/** Large enough for a list of sample items with rich text, small enough that a preview never weighs on the editor. */
const MAX_SPEC_CHARS = 200_000;

/** A preview request as the editor sent it, kept only when it is well formed. */
export function previewSpec(v: unknown): ComponentPreviewSpec | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const { definitionId, componentId, variants, props } = v as Record<string, unknown>;
  const id = (x: unknown) => x === undefined || (typeof x === 'string' && x.length > 0 && x.length <= 200);
  const record = (x: unknown) => x === undefined || (!!x && typeof x === 'object' && !Array.isArray(x));
  if (!id(definitionId) || !id(componentId) || !record(variants) || !record(props)) return null;
  if (variants && !Object.values(variants).every((o) => typeof o === 'string')) return null;
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
  return spec;
}

/**
 * Write a preview's files under a new key, all at once: the folder only appears under its key once every file is
 * in it, so the preview server never serves part of one. Returns the key and the address the server shows it at.
 */
export async function writeComponentPreview(root: string, files: FileMap): Promise<{ key: string; path: string }> {
  const base = isolatedRoot(root);
  await fs.mkdir(base, { recursive: true });
  // The cache must really be the project's: a link planted there must not make the editor write elsewhere.
  if (!realFileInside(root, base)) throw new Error('The editor’s preview cache is not inside the project folder.');
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

/** Remove one preview's files. */
export async function removeComponentPreview(root: string, key: string): Promise<void> {
  if (!PREVIEW_KEY.test(key)) return;
  await fs.rm(join(isolatedRoot(root), key), { recursive: true, force: true });
}

/** Remove every preview's files: left by a preview server that stopped, or by an app that did not close. */
export async function clearComponentPreviews(root: string): Promise<void> {
  const base = isolatedRoot(root);
  // Only the cache's own folder is cleared, never what a link there leads to.
  const st = await fs.lstat(base).catch(() => null);
  if (!st) return;
  if (st.isSymbolicLink() || !st.isDirectory()) await fs.rm(base, { force: true });
  else await fs.rm(base, { recursive: true, force: true });
}
