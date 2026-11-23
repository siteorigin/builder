/**
 * The preview's editor instrumentation, as a Vite plugin: serves the editor's instrumented variants from
 * .siteorigin/cache/dev in place of the project's own source files, and the selection bridge as a virtual module.
 * Kept apart from the worker so it can be tested.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import bridgeSource from './bridge.client.js?raw';
import { realFileInside } from './policy';
import { projectSrcPath, wholeModuleId } from './paths';

/**
 * Hashes of the project files the dev variants stand in for, written by the editor next to the variants
 * (before the project files themselves), re-read when they change.
 */
let manifest: { mtimeMs: number; files: Record<string, string> } | null = null;
function generatedHashes(dir: string): Record<string, string> {
  const file = join(dir, '.siteorigin', 'cache', 'dev', '.clean-hashes.json');
  try {
    const cache = join(dir, '.siteorigin', 'cache', 'dev');
    if (!realFileInside(cache, file) || !realFileInside(dir, file)) return {};
    const mtimeMs = statSync(file).mtimeMs;
    if (manifest?.mtimeMs !== mtimeMs) manifest = { mtimeMs, files: JSON.parse(readFileSync(file, 'utf8')) ?? {} };
    return manifest.files;
  } catch {
    return {};
  }
}

/** Does the project file differ from what the editor generated for it? */
function editedOutside(dir: string, rel: string): boolean {
  const expected = generatedHashes(dir)[rel];
  if (!expected) return false;
  try {
    return createHash('sha256').update(readFileSync(join(dir, ...rel.split('/')))).digest('hex') !== expected;
  } catch {
    return false;
  }
}

export function devPlugin(dir: string) {
  const devRoot = join(dir, '.siteorigin', 'cache', 'dev');
  const VIRTUAL = 'virtual:siteorigin-bridge';
  // Vite names modules by real path, so a project opened through a link is matched by both names.
  const names = [dir];
  try {
    const real = realpathSync.native(dir);
    if (real !== dir) names.push(real);
  } catch {
    // The folder is checked again when Vite starts; keep the name it was opened by.
  }
  return {
    name: 'siteorigin-editor-instrumentation',
    enforce: 'pre' as const,
    resolveId(id: string) {
      if (id === VIRTUAL) return '\0' + VIRTUAL + '.js';
      return null;
    },
    load(id: string) {
      if (id === '\0' + VIRTUAL + '.js') return bridgeSource;
      // Only the module itself is replaced. A request for something derived from the file (a component's stylesheet
      // above all) goes to the plugin that serves it: handed the variant, the whole component source became the
      // stylesheet, and SvelteKit's server-rendered page parsed it as markup.
      if (!wholeModuleId(id)) return null;
      const rel = projectSrcPath(names, id);
      if (!rel) return null;
      const variant = join(devRoot, ...rel.split('/'));
      if (!existsSync(variant)) return null;
      // Only a file really inside the cache (no link out of it) is ever served in place of the project's.
      if (!realFileInside(devRoot, variant) || !realFileInside(dir, variant)) return null;
      // A generated file edited outside the app is shown as edited, not as the editor's instrumented copy.
      if (editedOutside(dir, rel)) return null;
      return readFileSync(variant, 'utf8');
    }
  };
}
