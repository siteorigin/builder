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
