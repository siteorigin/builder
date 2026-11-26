/**
 * The theme packs this run of the app uses: loaded once at startup, while the first editor window loads and before
 * anything can open a project or read the catalogue (packs/gate.ts), from the releases in the app's resources and the
 * person's `userData/packs` folder. Adding, changing or removing a pack takes effect at the next start.
 */
import { join } from 'node:path';
import { registerPacks } from '@catalogue/index';
import type { PackCatalogue } from '@shared/api';
import { clearPackFiles, packFileInfo, readPackFile, registerPackFiles } from './files';
import { loadPacks, type PackRoot } from './loader';

let catalogue: PackCatalogue = { packs: [], refused: [], userDir: '' };

/**
 * Where packs are read from: the app's own, its development fixtures, then the person's. Fixtures ship too, so a
 * project switched to one in development stays editable; they are only offered in development builds.
 */
export function packRoots(resources: string, userData: string): PackRoot[] {
  return [
    { dir: join(resources, 'resources', 'packs'), source: 'bundled' },
    { dir: join(resources, 'resources', 'packs-dev'), source: 'bundled' },
    { dir: join(userData, 'packs'), source: 'user' }
  ];
}

/** Load and register every valid pack under these folders. */
export async function loadInstalledPacks(roots: PackRoot[]): Promise<PackCatalogue> {
  const { packs, refused } = await loadPacks(roots);
  const userDir = roots.find((r) => r.source === 'user')?.dir ?? '';
  const builtInMissing = !packs.some((p) => p.pack.source === 'bundled' && !p.pack.devOnly);
  if (builtInMissing) refused.unshift({ dir: roots[0]?.dir ?? '', reason: 'Missing from this installation of SiteOrigin Builder.' });
  for (const r of refused) console.warn(`Theme pack refused (${r.dir}): ${r.reason}`);
  // A development build makes its built-in theme with a script; a person reinstalls instead (StartupFailure.tsx says so).
  if (builtInMissing) console.warn('Run "npm run build:packs" to build the built-in theme.');
  clearPackFiles();
  registerPacks(packs.map((p) => p.pack));
  for (const p of packs) registerPackFiles(p.pack.id, p.files);
  catalogue = { packs: packs.map((p) => p.pack), refused, userDir };
  return catalogue;
}

/** The loaded packs, for the editor window. */
export function installedCatalogue(): PackCatalogue {
  return catalogue;
}

/** A preview image of a loaded pack, as a data URL the editor can show under its content security policy. */
export async function packPreview(packId: unknown, file: unknown): Promise<string | null> {
  if (typeof packId !== 'string' || typeof file !== 'string' || !file.startsWith('previews/') || !packFileInfo(packId, file)) return null;
  try {
    return `data:image/webp;base64,${(await readPackFile(packId, file)).toString('base64')}`;
  } catch {
    return null;
  }
}
