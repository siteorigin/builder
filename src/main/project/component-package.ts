/**
 * Component packages on disk (#371): the file written for a project component, and a file read, checked and made
 * ready to import. What a package holds, and how it lands, is the engine's (engine/component-package.ts).
 */
import { promises as fs } from 'node:fs';
import type { AssetRecord, ProjectState } from '@shared/types';
import {
  MAX_PACKAGE_BYTES,
  MAX_PACKAGE_IMAGE_BYTES,
  MAX_PACKAGE_IMAGES_BYTES,
  PACKAGE_IMAGE_EXTENSIONS,
  PackageError,
  decodeComponentPackage,
  type ComponentPackage,
  type PackageImageMime
} from '@shared/component-package';
import { importedCode, migratePackage, planComponentPackage, type ComponentImport } from '@engine/component-package';
import { newId } from '@shared/ids';
import { readRegularFile } from '../packs/files';
import { safeJoin, sha } from './fsutil';
import { importPackageImage, type WriteFence } from './assets';

const MB = 1024 * 1024;

/**
 * The package file for one project component: its text, and what it leaves out. Each image it shows is read from the
 * project folder and must still be the file its library record names. Fails, saying why, when it can't be made.
 */
export async function buildComponentPackage(projectDir: string, state: ProjectState, definitionId: string, app?: string): Promise<{ text: string; notes: string[]; pkg: ComponentPackage }> {
  const { pkg, images, notes } = planComponentPackage(state, definitionId, app);
  let total = 0;
  for (const a of images) {
    const buf = await readRegularFile(safeJoin(projectDir, a.file), MAX_PACKAGE_IMAGE_BYTES).catch(() => null);
    if (!buf || sha(buf) !== a.hash) throw new Error(`The image “${a.name}” is missing from the project folder or has changed since it was added. Locate it in Assets, then export again.`);
    total += buf.length;
    if (total > MAX_PACKAGE_IMAGES_BYTES) throw new Error(`Its images add up to more than ${MAX_PACKAGE_IMAGES_BYTES / MB} MB, more than one package carries. Use smaller images first.`);
    pkg.images.push({
      id: a.id,
      name: a.name,
      mime: a.mime as PackageImageMime,
      hash: a.hash,
      data: buf.toString('base64'),
      ...(a.description ? { description: a.description } : {}),
      ...(a.altSuggestion ? { altSuggestion: a.altSuggestion } : {})
    });
  }
  const text = `${JSON.stringify(pkg, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_PACKAGE_BYTES) throw new Error(`The package would be larger than ${MAX_PACKAGE_BYTES / MB} MB. Use smaller images first.`);
  // Only a package this app can read again is written.
  decodeComponentPackage(text);
  return { text, notes, pkg };
}

/** Read a package file, check its structure and bring its components to the current format. Throws a PackageError. */
export async function readComponentPackage(path: string): Promise<ComponentPackage> {
  const size = await fs.stat(path).then(
    (st) => (st.isFile() ? st.size : -1),
    () => -1
  );
  if (size < 0) throw new PackageError('That component package could not be found. It may have been moved or deleted.');
  if (size > MAX_PACKAGE_BYTES) throw new PackageError(`This component package can’t be imported: it is larger than ${MAX_PACKAGE_BYTES / MB} MB.`);
  let buf: Buffer;
  try {
    buf = await readRegularFile(path, MAX_PACKAGE_BYTES);
  } catch (e) {
    throw new PackageError(`That component package could not be read: ${(e as Error).message}`);
  }
  return migratePackage(decodeComponentPackage(buf.toString('utf8')));
}

/** A package ready to land: the import its operation names, and the library records its new images need. */
export interface PreparedImport {
  input: ComponentImport;
  assets: Array<{ type: 'asset.add'; asset: AssetRecord }>;
}

/**
 * Store a package's images in the project, each checked as the library checks a file it imports, and say which library
 * record each became: one the library already has for the same picture, or a new one to add with the import. Nothing
 * is written for a package that would bring code into a project that may not have it (`codeAllowed`), or once any image
 * is refused. Files written for an import that then fails are swept with the project's other unused files.
 */
export async function preparePackageImport(projectDir: string, state: ProjectState, pkg: ComponentPackage, opts: { codeAllowed: boolean; fence?: WriteFence }): Promise<PreparedImport> {
  const input: ComponentImport = { id: newId('imp'), pkg, images: {} };
  const code = importedCode(state, input);
  if (code.length && !opts.codeAllowed)
    throw new PackageError(
      `This package includes ${code.length === 1 ? `the code component “${code[0].name}”` : `${code.length} code components`}, which ${code.length === 1 ? 'needs' : 'need'} Developer mode. Turn on Developer mode in Settings to import it.`
    );
  const known = Object.values(state.assets.assets);
  const assets: PreparedImport['assets'] = [];
  const createdAt = new Date().toISOString();
  for (const img of pkg.images) {
    const bytes = Buffer.from(img.data, 'base64');
    if (sha(bytes) !== img.hash) throw new PackageError(`This component package can’t be imported: the image “${img.name}” in it is damaged.`);
    let stored: { record: AssetRecord; existing: boolean };
    try {
      stored = await importPackageImage(projectDir, { name: img.name, mime: img.mime, ext: PACKAGE_IMAGE_EXTENSIONS[img.mime], bytes }, known, opts.fence, createdAt);
    } catch (e) {
      throw new PackageError(`This component package can’t be imported: ${(e as Error).message}`);
    }
    if (!stored.existing) {
      if (img.description) stored.record.description = img.description;
      if (img.altSuggestion) stored.record.altSuggestion = img.altSuggestion;
      assets.push({ type: 'asset.add', asset: stored.record });
      known.push(stored.record);
    }
    input.images[img.id] = stored.record.id;
  }
  return { input, assets };
}
