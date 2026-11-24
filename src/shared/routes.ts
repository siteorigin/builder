/** Static route rules for pages. Routes always start and end with "/". */

const RESERVED = new Set(['_app', 'assets', 'api', '__data.json', 'sitemap.xml', 'robots.txt', 'favicon.ico', '_siteorigin']);

/** Combining marks NFKD splits off accented letters ("é" is "e" and an accent). */
const ACCENTS = /[\u0300-\u036f]/g;

export function slugify(text: string): string {
  return (
    text
      .normalize('NFKD')
      .replace(ACCENTS, '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, 60)
      // Trimmed after the cut, which may land on the hyphen between two words.
      .replace(/-+$/, '')
  );
}

/**
 * A route as someone may type it ("About Us", "/Café Menu"): each segment lowercased, without accents, and with its
 * spaces as hyphens. Anything else a segment cannot hold is left for validateRoute to refuse, so a reserved or
 * hidden name ("_app") is never quietly turned into an ordinary one.
 */
export function normalizeRoute(input: string): string {
  const parts = input
    .normalize('NFKD')
    .replace(ACCENTS, '')
    .trim()
    .split('/')
    .map((p) => p.trim().toLowerCase().replace(/\s+/g, '-'))
    .filter(Boolean);
  return parts.length ? `/${parts.join('/')}/` : '/';
}

/** Returns an error message, or null when the route is valid. */
export function validateRoute(route: string): string | null {
  if (route === '/') return null;
  if (!route.startsWith('/') || !route.endsWith('/')) return 'Routes must start and end with "/".';
  const segments = route.slice(1, -1).split('/');
  if (segments.length > 4) return 'Routes can be at most four levels deep.';
  for (const seg of segments) {
    if (!seg) return 'Routes cannot contain empty segments.';
    if (seg === '.' || seg === '..') return 'Routes cannot contain "." or "..".';
    if (!/^[a-z0-9][a-z0-9-]*$/.test(seg)) return `"${seg}" may only contain lowercase letters, numbers and hyphens.`;
    if (seg.length > 60) return 'Route segments must be 60 characters or fewer.';
  }
  if (RESERVED.has(segments[0]) || segments[0].startsWith('_')) return `"/${segments[0]}/" is reserved.`;
  return null;
}

/** Directory under src/routes for a route ("" for home). */
export function routeDir(route: string): string {
  return route.replace(/^\/+|\/+$/g, '');
}

/**
 * The address a page titled `title` gets in `folder` ("/" for the top level, or a page's address for a page inside
 * it): its slug, made valid when it is a reserved name, with a numbered suffix while `taken` says the address is
 * in use, kept within the 60-character segment limit. `base` is the address before any suffix and `reserved` the
 * reserved address it avoided. The Pages panel previews new addresses with it, so the preview is what the page gets.
 */
export function suggestRoute(title: string, taken: (route: string) => boolean, fallback = 'page', folder = '/'): { route: string; base: string; reserved?: string } {
  let slug = slugify(title) || fallback;
  const first = `${folder}${slug}/`;
  // Only a top-level name can be reserved; deeper, a slug is always a valid segment.
  const reserved = folder === '/' && validateRoute(first) ? first : undefined;
  if (reserved) slug = `${slug.slice(0, 55)}-page`;
  const base = `${folder}${slug}/`;
  let route = base;
  for (let i = 2; taken(route); i++) route = `${folder}${slug.slice(0, 60 - `-${i}`.length).replace(/-+$/, '')}-${i}/`;
  return reserved ? { route, base, reserved } : { route, base };
}
