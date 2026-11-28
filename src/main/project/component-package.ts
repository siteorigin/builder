/**
 * Component packages on disk (#371): the file written for a project component, and a file read, checked and made
 * ready to import. What a package holds, and how it lands, is the engine's (engine/component-package.ts).
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { createStarterState } from '@catalogue/starters';
import { ProjectSession } from './session';
import { siteIconRecord } from './site-icons';

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
  // Only a package this app can read again is written, and only one another project can import (#1417): code the
  // author's project saves with warnings may be what an import, holding a package's code to a stricter policy, refuses.
  await trialImport(migratePackage(decodeComponentPackage(text)), state.site.themeId);
  return { text, notes, pkg };
}

/**
 * Import a package as the editor does, with Developer mode on, into a blank project on the theme it was made on (`themeId`),
 * made for it in a folder of its own and removed afterwards: whatever that import refuses, a new project on that theme
 * in this build would refuse too. Throws the reason.
 */
async function trialImport(pkg: ComponentPackage, themeId: string): Promise<void> {
  let dir: string | null = null;
  let session: ProjectSession | null = null;
  let refused: string | null = null;
  try {
    dir = await fs.mkdtemp(join(tmpdir(), 'so-package-check-'));
    // Kept before its first file is written, so a project that fails to be made is still closed.
    session = ProjectSession.starting(dir, createStarterState('blank', 'Package check', false, themeId));
    await session.writeNew();
    // As the editor imports: the package's images are written before their records land, with sweeping held off.
    const trial = session;
    const at = dir;
    refused = await trial.withImport(async () => {
      let prepared: PreparedImport;
      try {
        prepared = await preparePackageImport(at, trial.state, pkg, { codeAllowed: true });
      } catch (e) {
        if (e instanceof PackageError) return e.message;
        throw e;
      }
      const r = await trial.apply(
        { operations: [...prepared.assets, { type: 'component.import', importId: prepared.input.id }] },
        { label: 'Import component', source: 'user', codeAllowed: true, componentImport: prepared.input }
      );
      return r.ok ? null : (r.error?.message ?? 'it could not be added.').replace(/^Operation \d+ \([\w.]+\): /, '');
    });
  } catch (e) {
    throw new Error(`whether another project could import it could not be checked: ${(e as Error).message}`);
  } finally {
    await session?.close().catch(() => undefined);
    if (dir) {
      // Nor is the note of its site icons, kept for a project's next opening, left behind.
      const icons = siteIconRecord(dir);
      if (icons) await fs.rm(icons.file, { force: true }).catch(() => undefined);
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  if (refused) throw new Error(`another project would refuse it on import. ${refused.replace(/\s*$/, '')} Fix what it names, then try again.`);
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
