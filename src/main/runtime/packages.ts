/**
 * A project's own npm packages (#1480): the ones its package.json declares, as Project health lists them, and what a
 * change to them asks of npm. Only packages from the npm registry are added, by name with an optional version, range
 * or tag; the website's own tools (STARTER_PACKAGES) are listed but never changed here.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { ProjectPackage } from '@shared/api';
import { PACKAGE_SECTIONS, packageOf } from '../codecheck';
import { NETWORK_CODES } from './availability';
import { npmModule } from './manager';

/** The packages a new project is made with (templates/sveltekit-brochure): the website's own tools. */
export const STARTER_PACKAGES: ReadonlySet<string> = new Set(['@sveltejs/adapter-static', '@sveltejs/kit', '@sveltejs/vite-plugin-svelte', 'svelte', 'vite']);

type Section = ProjectPackage['section'];
/** How npm is told to keep a package in the section of package.json it is in already; a new one is a dependency. */
const SAVE_FLAG: Record<Section, string> = { dependencies: '--save-prod', devDependencies: '--save-dev', optionalDependencies: '--save-optional', peerDependencies: '--save-peer' };

/** A package.json's sections of packages, by name; empty when it can't be read. */
function sections(packageJson: string | null): Partial<Record<Section, Record<string, unknown>>> {
  let pkg: unknown;
  try {
    pkg = packageJson ? JSON.parse(packageJson) : null;
  } catch {
    return {};
  }
  const out: Partial<Record<Section, Record<string, unknown>>> = {};
  if (!pkg || typeof pkg !== 'object') return out;
  for (const section of PACKAGE_SECTIONS) {
    const deps = (pkg as Record<string, unknown>)[section];
    if (deps && typeof deps === 'object' && !Array.isArray(deps)) out[section] = deps as Record<string, unknown>;
  }
  return out;
}

/** The section of package.json that declares `name`, or null when none does. */
const sectionOf = (deps: ReturnType<typeof sections>, name: string): Section | null => PACKAGE_SECTIONS.find((s) => !!deps[s] && Object.hasOwn(deps[s]!, name)) ?? null;

/**
 * The packages `packageJson` (the project's in `dir`) declares, each with the version set up in its website tools, or
 * null when it is not set up there. The project's own come first, by name, then the website's tools.
 */
export async function listPackages(dir: string, packageJson: string | null): Promise<ProjectPackage[]> {
  const deps = sections(packageJson);
  const list: ProjectPackage[] = [];
  for (const section of PACKAGE_SECTIONS)
    for (const [name, wanted] of Object.entries(deps[section] ?? {})) {
      // A name npm would never install (one that climbs out of node_modules, say) is not looked for there.
      if (packageOf(name) !== name || list.some((p) => p.name === name)) continue;
      const installed = await fs
        .readFile(join(dir, 'node_modules', name, 'package.json'), 'utf8')
        .then((t) => (JSON.parse(t) as { version?: unknown }).version)
        .catch(() => null);
      list.push({ name, wanted: typeof wanted === 'string' ? wanted : '', section, installed: typeof installed === 'string' ? installed : null, tool: STARTER_PACKAGES.has(name) });
    }
  return list.sort((a, b) => Number(a.tool) - Number(b.tool) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The version (or range) `packageJson` asks for of `name`, or null when it does not declare it. */
export function declaredVersion(packageJson: string | null, name: string): string | null {
  const deps = sections(packageJson);
  const section = sectionOf(deps, name);
  const wanted = section ? deps[section]![name] : null;
  return typeof wanted === 'string' ? wanted : null;
}

/** What npm is asked to do for one change to a project's packages, or why the change is refused. */
export type PackageRequest =
  | { ok: true; verb: 'add' | 'update' | 'remove'; name: string; command: 'install' | 'uninstall'; options: string[]; spec: string }
  | { ok: false; message: string };

interface ParsedSpec {
  type: string;
  name?: string | null;
  rawSpec: string;
}

const EXAMPLE = 'such as zod or zod@4.1.0';

/**
 * What npm is asked to do for `change` (from the editor, so checked as it comes) to the packages `packageJson`
 * declares: install a registry package, by name with an optional version, range or tag, keeping one the project has
 * in its section of package.json and pinning the version it gets; or uninstall one the project declares.
 */
export function packageRequest(change: unknown, packageJson: string | null): PackageRequest {
  const deps = sections(packageJson);
  const own = (name: string) => (STARTER_PACKAGES.has(name) ? `“${name}” is one of the website’s own tools, which SiteOrigin Builder keeps at the version the site was made with.` : null);
  const c = (change && typeof change === 'object' ? change : {}) as Partial<Record<'add' | 'remove', unknown>>;
  if (typeof c.add === 'string') {
    const raw = c.add.trim();
    if (!raw) return { ok: false, message: `Type the name of a package, ${EXAMPLE}.` };
    let parsed: ParsedSpec;
    try {
      parsed = raw.length <= 256 ? npmModule<(spec: string) => ParsedSpec>('npm-package-arg')(raw) : { type: 'too-long', rawSpec: '' };
    } catch {
      parsed = { type: 'invalid', rawSpec: '' };
    }
    const name = parsed.name ?? '';
    const valid = !!name && packageOf(name) === name && npmModule<(n: string) => { validForOldPackages: boolean }>('validate-npm-package-name')(name).validForOldPackages;
    if (!['range', 'version', 'tag'].includes(parsed.type) || !valid) return { ok: false, message: `“${raw}” isn’t a package from npm. Type a package’s name, with a version if you like, ${EXAMPLE}.` };
    const refused = own(name);
    if (refused) return { ok: false, message: refused };
    const section = sectionOf(deps, name);
    const version = parsed.rawSpec.trim();
    return { ok: true, verb: section ? 'update' : 'add', name, command: 'install', options: ['--save-exact', SAVE_FLAG[section ?? 'dependencies']], spec: version && version !== '*' ? `${name}@${version}` : name };
  }
  if (typeof c.remove === 'string') {
    const name = c.remove;
    const refused = own(name);
    if (refused) return { ok: false, message: refused };
    if (packageOf(name) !== name || !sectionOf(deps, name)) return { ok: false, message: `The project doesn’t have the package “${name}”.` };
    return { ok: true, verb: 'remove', name, command: 'uninstall', options: [], spec: name };
  }
  return { ok: false, message: `Type the name of a package, ${EXAMPLE}.` };
}

/** What to tell the author when npm could not work out a change (`e`, from resolvePackageFiles). */
export function packageFailure(req: Extract<PackageRequest, { ok: true }>, e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  const detail = ((e as Error | null)?.message ?? String(e)).replace(/^Installing dependencies failed \(exit [^)]*\)\.\s*/, '').trim();
  if (code === 'E404') return `npm has no package called “${req.name}”. Check its name, then try again.`;
  if (code === 'ETARGET') return `“${req.name}” has no version that matches “${req.spec.slice(req.name.length + 1)}”. Check the version, or leave it out to get the latest.`;
  if (typeof code === 'string' && NETWORK_CODES.includes(code)) return `The npm registry couldn’t be reached (${code}). Check the internet connection, then try again.`;
  if (code === 'ERESOLVE') return `“${req.name}” doesn’t fit with the project’s other packages: ${detail}`;
  return `npm couldn’t ${req.verb} “${req.name}”${detail ? `: ${detail}` : '.'}`;
}
