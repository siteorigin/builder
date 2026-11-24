/**
 * Where a module Vite asks for sits under the project's src/, as a forward-slash path relative to the project
 * root ("src/routes/+page.svelte"); null when it is anywhere else. Vite hands load() forward-slash ids on every
 * platform while node:path on Windows uses backslashes, so both sides are compared in Vite's form. Pass every
 * name the project folder goes by (as opened, and its real path when it is reached through a link).
 */
export function projectSrcPath(dirs: string | string[], id: string): string | null {
  if (id.startsWith('\0')) return null;
  // Vite's form: forward slashes, no repeated slashes (a UNC root's "//" included).
  const slash = (p: string) => p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  const clean = slash(id.split('?')[0]);
  for (const dir of Array.isArray(dirs) ? dirs : [dirs]) {
    const root = slash(dir).replace(/\/+$/, '');
    // Windows paths compare without regard to case, as the file system does.
    const windows = /^[a-z]:\//i.test(root) || /\\/.test(dir);
    const key = (p: string) => (windows ? p.toLowerCase() : p);
    if (!root || !key(clean).startsWith(key(root) + '/')) continue;
    const rel = clean.slice(root.length + 1);
    if (!rel.startsWith('src/') || rel.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')) return null;
    return rel;
  }
  return null;
}

/**
 * Does a module id Vite asks for name the module itself, rather than something derived from its file? Importers add
 * queries for those: a Svelte component's stylesheet (`?svelte&type=style&lang.css`, and SvelteKit's `?inline&…`
 * for the styles it writes into a server-rendered page), `?raw`, `?url`, `?direct`. Only a dependency version stamp
 * (`?v=`, alone) still names the module.
 */
export function wholeModuleId(id: string): boolean {
  const q = id.indexOf('?');
  return q < 0 || /^(?:v=[\w.-]*)?$/.test(id.slice(q + 1));
}

/**
 * Where a module Vite asks for sits inside a prepared component preview (`<project>/.siteorigin/cache/dev/isolated/
 * <key>/…`): the preview's key and the file's forward-slash path inside its folder; null for anything else. Pass
 * every name the project folder goes by, as for projectSrcPath.
 */
export function isolatedPreviewPath(dirs: string | string[], id: string, isolated: string, keyPattern: RegExp): { key: string; rel: string } | null {
  if (id.startsWith('\0')) return null;
  const slash = (p: string) => p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  const clean = slash(id.split('?')[0]);
  for (const dir of Array.isArray(dirs) ? dirs : [dirs]) {
    const root = `${slash(dir).replace(/\/+$/, '')}/.siteorigin/cache/dev/${isolated}`;
    const windows = /^[a-z]:\//i.test(root) || /\\/.test(dir);
    const key = (p: string) => (windows ? p.toLowerCase() : p);
    if (!key(clean).startsWith(key(root) + '/')) continue;
    const [previewKey, ...segments] = clean.slice(root.length + 1).split('/');
    if (!keyPattern.test(previewKey) || !segments.length || segments.some((seg) => seg === '..' || seg === '.' || seg === '')) return null;
    return { key: previewKey, rel: segments.join('/') };
  }
  return null;
}

/**
 * Does a module id name the module itself, allowing the stamps Vite adds to a module it reloads (`t=`) or imports
 * explicitly (`import`) as well as a version stamp? For files that never change under the same name, so a stamp
 * can only name the same bytes.
 */
export function plainModuleId(id: string): boolean {
  const q = id.indexOf('?');
  if (q < 0) return true;
  return id
    .slice(q + 1)
    .split('&')
    .every((part) => part === '' || part === 'import' || /^[tv]=[\w.-]*$/.test(part));
}
