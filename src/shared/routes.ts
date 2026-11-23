/** Static route rules for pages. Routes always start and end with "/". */

const RESERVED = new Set(['_app', 'assets', 'api', '__data.json', 'sitemap.xml', 'robots.txt', 'favicon.ico', '_siteorigin']);

export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function normalizeRoute(input: string): string {
  const parts = input
    .trim()
    .split('/')
    .map((p) => p.trim().toLowerCase())
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
