/**
 * Export helpers: copying a clean snapshot of a project, checking it, and making the exported source ready
 * to hand over. Nothing here depends on Electron, so it is unit tested directly.
 */
import { existsSync, lstatSync, promises as fs } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import type { AssetRecord, ProjectState } from '@shared/types';
import { STARTER_ASSETS } from '@catalogue/starters';
import { readIfExists, sha } from './project/fsutil';

const EXCLUDE_TOP = new Set(['node_modules', '.siteorigin', '.svelte-kit', 'build', '.git', '.DS_Store']);

/** Private files that never leave the project folder. */
const PRIVATE_FILE = /^(\.env(\..*)?|\.npmrc|\.netrc|\.git-credentials|id_rsa.*|id_ed25519.*|id_ecdsa.*|id_dsa.*|.*\.(pem|key|p12|pfx|ppk|keystore|jks|asc|gpg))$/i;

export async function copyProjectSource(src: string, dest: string, opts: { keepAsset?: (rel: string) => boolean } = {}) {
  await fs.cp(src, dest, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (p) => {
      const rel = relative(src, p);
      if (!rel) return true;
      const top = rel.split(sep)[0];
      if (EXCLUDE_TOP.has(top) || /\.tmp$/.test(p)) return false;
      if (PRIVATE_FILE.test(basename(p))) return false;
      try {
        if (lstatSync(p).isSymbolicLink()) return false;
        if (opts.keepAsset && lstatSync(p).isFile() && !opts.keepAsset(rel.split(sep).join('/'))) return false;
      } catch {
        return false;
      }
      return true;
    }
  });
}

/** Project files (static/assets/…) of every asset record in the library and its responsive variants, used or not. */
export function libraryAssetFiles(state: ProjectState): Set<string> {
  const out = new Set<string>();
  for (const a of Object.values(state.assets.assets)) {
    out.add(a.file);
    for (const v of a.variants ?? []) out.add(v.file);
  }
  return out;
}

/** The name the asset importer gives a file: a slug, eight hash characters and an optional width. */
const IMPORTED_ASSET = /^[^/]+-[0-9a-f]{8}(-\d+w)?\.[a-z0-9]+$/i;

/**
 * Which project files an export carries. Every library file stays, used or not, because the editable project
 * keeps them for later; imported images that no asset record or code component uses any more (deleted images
 * kept for undo) stay behind. Anything else in static/ was put there on purpose. The website build narrows
 * this further with pruneWebsiteAssets.
 */
export function exportedAssetFilter(state: ProjectState): (rel: string) => boolean {
  const library = libraryAssetFiles(state);
  const code = Object.values(state.components).map((d) => d.source ?? '').join('\n');
  return (rel) => {
    if (!rel.startsWith('static/assets/') || library.has(rel)) return true;
    const name = rel.slice('static/assets/'.length);
    return !IMPORTED_ASSET.test(name) || code.includes(name);
  };
}

/** Files the website build reads as text, searched for the asset file names they use. */
const TEXT_FILE = /\.(svelte|[cm]?[jt]sx?|css|html?|json|webmanifest|xml|txt|svg|md)$/i;

/** Does `text` name `file` as a whole file name, so that `a-1234abcd.svg` is not found inside `ba-1234abcd.svg`? */
function namesFile(text: string, file: string): boolean {
  for (let i = text.indexOf(file); i >= 0; i = text.indexOf(file, i + 1)) if (i === 0 || !/[\w.-]/.test(text[i - 1])) return true;
  return false;
}

/**
 * Remove the library files the public website does not use from a staged copy of the project, before it is
 * built. A file in static/assets/ that belongs to an asset record, or is named like an imported file, ships
 * only when something the build reads names it: generated pages (images and their srcset variants, the
 * favicon, social images), the @font-face rules, code components, hand-written source and other public files.
 * The authoring documents under siteorigin/ list the whole library, so they do not count. Returns the asset
 * records none of whose files ship, so the export can say what it left out.
 */
export async function pruneWebsiteAssets(project: string, state: ProjectState): Promise<AssetRecord[]> {
  const library = libraryAssetFiles(state);
  const files = (await listFiles(project)).map((f) => f.split(sep).join('/'));
  const candidate = (rel: string) => rel.startsWith('static/assets/') && (library.has(rel) || IMPORTED_ASSET.test(rel.slice('static/assets/'.length)));
  const texts: string[] = [];
  for (const rel of files) {
    if (candidate(rel) || rel === 'siteorigin.project.json' || rel.startsWith('siteorigin/') || !TEXT_FILE.test(rel)) continue;
    texts.push(await fs.readFile(join(project, rel), 'utf8'));
  }
  const text = texts.join('\n');
  const shipped = new Set<string>();
  const removed = new Set<string>();
  for (const rel of files.filter(candidate)) {
    if (namesFile(text, basename(rel))) shipped.add(rel);
    else {
      await fs.rm(join(project, rel));
      removed.add(rel);
    }
  }
  return Object.values(state.assets.assets).filter((a) => {
    const own = [a.file, ...(a.variants ?? []).map((v) => v.file)];
    return own.some((f) => removed.has(f)) && !own.some((f) => shipped.has(f));
  });
}

/** The export note naming the library assets a website export left out, if any. */
export function omittedAssetsWarning(omitted: AssetRecord[]): string | undefined {
  const names = omitted.map((a) => a.name).sort();
  if (!names.length) return undefined;
  if (names.length === 1) return `${names[0]} is not used anywhere on the site, so it was left out of the website. It stays in the project's assets.`;
  const shown = names.length > 5 ? `${names.slice(0, 5).join(', ')} and ${names.length - 5} more` : names.join(', ');
  return `${names.length} assets not used anywhere on the site were left out of the website: ${shown}. They stay in the project's assets.`;
}

/** Copy a finished export to `dest`, which must not exist yet. Only a folder created here is ever removed. */
export async function publishFolder(from: string, dest: string) {
  await fs.mkdir(dest);
  try {
    await fs.cp(from, dest, { recursive: true });
  } catch (e) {
    await fs.rm(dest, { recursive: true, force: true });
    throw e;
  }
}

const MANIFEST_PATH = 'siteorigin/generated-manifest.json';

/** The first generated file whose content no longer matches generated-manifest.json, or null. */
export async function editedGeneratedFile(dir: string): Promise<string | null> {
  let manifest: { files?: Record<string, string> };
  try {
    manifest = JSON.parse((await readIfExists(join(dir, MANIFEST_PATH))) ?? '');
  } catch {
    return MANIFEST_PATH;
  }
  for (const [path, hash] of Object.entries(manifest.files ?? {}).sort()) {
    const disk = await readIfExists(join(dir, path));
    if (disk === null || sha(disk) !== hash) return path;
  }
  return null;
}

/** Content hash of everything an export reads: source, public files and the canonical documents. */
export async function projectFingerprint(dir: string): Promise<string> {
  const parts: string[] = [];
  for (const top of ['src', 'static', 'siteorigin']) {
    for (const f of (await listFiles(join(dir, top))).filter((n) => !n.endsWith('.tmp')).sort()) parts.push(`${top}/${f}:${sha(await fs.readFile(join(dir, top, f)))}`);
  }
  return sha(parts.join('\n'));
}

/** Old exported projects pinned Node more tightly than the toolchain needs, which broke hosted builds. */
const LEGACY_ENGINES = '^22.22.2 || ^24.15.0 || >=26.0.0';
export const NODE_ENGINES = '>=22.17.0';

/** Make an exported source project ready to hand over: current README, notices and a portable engines field. */
export async function finishExportedSource(dest: string, state: ProjectState, noticePath: string) {
  const readmePath = join(dest, 'README.md');
  const readme = await readIfExists(readmePath);
  if (readme === null || isGeneratedReadme(readme)) await fs.writeFile(readmePath, projectReadme(state.site.name));
  const usesSamples = STARTER_ASSETS.some((a) => state.assets.assets[a.id]);
  if (usesSamples && !existsSync(join(dest, 'NOTICE.md')) && existsSync(noticePath)) await fs.copyFile(noticePath, join(dest, 'NOTICE.md'));
  for (const [file, at] of [['package.json', (j: Record<string, any>) => j], ['package-lock.json', (j: Record<string, any>) => j.packages?.['']]] as const) {
    const text = await readIfExists(join(dest, file));
    if (!text) continue;
    const json = JSON.parse(text);
    const target = at(json);
    if (target?.engines?.node === LEGACY_ENGINES) {
      target.engines.node = NODE_ENGINES;
      await fs.writeFile(join(dest, file), JSON.stringify(json, null, '\t') + '\n');
    }
  }
}

export async function listFiles(dir: string, base = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(join(dir, base), { withFileTypes: true }).catch(() => [])) {
    const rel = base ? join(base, e.name) : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

const README_INTRO = 'This website was created with [SiteOrigin Builder](https://siteorigin.com).';

/** Whether a README is one this app wrote (current or earlier wording) rather than the owner's own. */
export function isGeneratedReadme(text: string): boolean {
  // A checkout may have converted the line endings of an otherwise untouched file.
  const normalized = text.replace(/\r\n/g, '\n');
  const title = normalized.match(/^# (.*)\n/)?.[1];
  if (title === undefined) return false;
  return normalized === projectReadme(title) || normalized === legacyReadme(title);
}

export function projectReadme(name: string): string {
  return `# ${name}

${README_INTRO} It is a normal [SvelteKit](https://svelte.dev/docs/kit) project and does not need SiteOrigin Builder to run or build.

## Requirements

- Node.js 22.17 or newer (24 LTS recommended)

## Commands

\`\`\`sh
npm ci          # install the locked dependencies
npm run dev     # start a local development server
npm run build   # build the static website into build/
npm run preview # preview the production build
\`\`\`

The static website is written to \`build/\`. Upload the contents of that folder to any static host. If the site lives in a sub-folder (for example on GitHub Pages), that path comes from \`src/lib/siteorigin/paths.json\`.

## Project layout

- \`src/routes/\` and \`src/lib/siteorigin/\`: generated SvelteKit pages, components and styles.
- \`src/lib/siteorigin/custom/\`: code components you wrote. These are yours to edit.
- \`siteorigin/\` and \`siteorigin.project.json\`: SiteOrigin Builder's editable documents. Keep them if you want to keep editing visually.

Files generated by SiteOrigin Builder start with a comment. If you edit them by hand, SiteOrigin Builder keeps your version and asks before regenerating them.

## Notices

The Foundation theme is licensed under GPL-3.0-or-later. Icons come from Lucide (ISC licence). Fonts are licensed under the SIL Open Font License 1.1 and are installed from npm (@fontsource-variable). Sample images from the Business starter, where still used, are described in NOTICE.md.
`;
}

/** The README written by earlier versions, recognised so that exports can bring it up to date. */
function legacyReadme(name: string): string {
  return `# ${name}

${README_INTRO} It is a normal [SvelteKit](https://svelte.dev/docs/kit) project and does not need SiteOrigin Builder to run or build.

## Requirements

- Node.js 22.22 or newer (24 LTS recommended)

## Commands

\`\`\`sh
npm ci          # install the locked dependencies
npm run dev     # start a local development server
npm run build   # build the static website into build/
npm run preview # preview the production build
\`\`\`

The static website is written to \`build/\`. Upload the contents of that folder to any static host.

## Project layout

- \`src/routes/\` and \`src/lib/siteorigin/\`: generated SvelteKit pages, components and styles.
- \`src/lib/siteorigin/custom/\`: code components you wrote. These are yours to edit.
- \`siteorigin/\` and \`siteorigin.project.json\`: SiteOrigin Builder's editable documents. Keep them if you want to keep editing visually.

Files generated by SiteOrigin Builder start with a comment. If you edit them by hand, SiteOrigin Builder keeps your version and asks before regenerating them.

## Notices

The Foundation theme is licensed under GPL-3.0-or-later. Icons come from Lucide (ISC licence). Inter and Fraunces fonts are licensed under the SIL Open Font License 1.1 and are installed from npm (@fontsource-variable).
`;
}

/** A path inside `parent` that does not exist yet: `base`, then `base-2`, `base-3`, … */
export function uniqueChild(parent: string, base: string): string {
  let p = join(parent, base);
  for (let i = 2; existsSync(p); i++) p = join(parent, `${base}-${i}`);
  return p;
}
