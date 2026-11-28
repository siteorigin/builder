/**
 * The project's own API endpoints (#1481): SvelteKit `+server.js` and `+server.ts` files under `src/routes/`, which the
 * developer writes and the generator never does. They are plain project files, not canonical documents: one written by
 * hand, outside the app, works as one made in it. What is here is shared by the editor and the main process, which reads
 * and writes them (src/main/project/endpoints.ts); nothing here touches the disk.
 */

export type EndpointLanguage = 'ts' | 'js';

/** An endpoint file of the project's, as the editor lists it. */
export interface EndpointFile {
  /** Its path in the project, with forward slashes: `src/routes/api/search/+server.ts`. */
  file: string;
  /**
   * Its route as SvelteKit reads it, from the folders it is in: `/api/search`, `/api/posts/[id]`. A folder in brackets
   * (a group, `(admin)`) is left out, as it is from the address.
   */
  route: string;
  language: EndpointLanguage;
  /** The request methods it appears to export a handler for (GET, POST, …, fallback), read from its text: advisory. */
  methods: string[];
}

/** The request methods an endpoint can answer, as the tester offers them. */
export const ENDPOINT_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'] as const;
export type EndpointMethod = (typeof ENDPOINT_METHODS)[number];

/** Where every endpoint the editor makes lives: the first part of the address no page can have (shared/routes.ts). */
export const ENDPOINT_PREFIX = '/api/';

/** An endpoint file's path: under src/routes, through folders of plain names, named +server.js or +server.ts. */
const ENDPOINT_FILE = /^src\/routes(?:\/[^/\\\0]+)*\/\+server\.(js|ts)$/;

/** One part of a new endpoint's address: lower-case letters, digits, hyphens, underscores and dots, from a letter or digit. */
const NEW_SEGMENT = /^[a-z0-9][a-z0-9._-]{0,59}$/;

/** At most this many parts after /api/. */
const MAX_SEGMENTS = 6;

/** The largest endpoint file the editor opens or saves, in bytes. */
export const MAX_ENDPOINT_BYTES = 512 * 1024;

/** Whether `file` names an endpoint file of the project's (see ENDPOINT_FILE), with no part that is `.` or `..`. */
export function isEndpointFile(file: unknown): file is string {
  return typeof file === 'string' && file.length <= 400 && ENDPOINT_FILE.test(file) && !file.split('/').some((p) => p === '.' || p === '..');
}

/** An endpoint file's route: its folders below src/routes, groups left out. */
export function endpointRoute(file: string): string {
  const parts = file.split('/').slice(2, -1);
  const kept = parts.filter((p) => !/^\(.*\)$/.test(p));
  return `/${kept.join('/')}`;
}

/** The language of an endpoint file, by its extension. */
export const endpointLanguage = (file: string): EndpointLanguage => (file.endsWith('.ts') ? 'ts' : 'js');

const METHOD_NAMES = new Set<string>([...ENDPOINT_METHODS, 'fallback']);

/**
 * The handlers an endpoint's text appears to export: `export function GET`, `export async function POST`,
 * `export const PUT =`, and `export { handler as DELETE }`, in the order SvelteKit's methods are listed. Read from the
 * text, so it is a hint for the tester, never a reason to refuse a request.
 */
export function endpointMethods(source: string): string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(/\bexport\s+(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+|var\s+)([A-Za-z_$][\w$]*)/g)) if (METHOD_NAMES.has(m[1])) found.add(m[1]);
  for (const list of source.matchAll(/\bexport\s*\{([^}]*)\}/g))
    for (const part of list[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && METHOD_NAMES.has(name)) found.add(name);
    }
  return [...ENDPOINT_METHODS, 'fallback'].filter((m) => found.has(m));
}

/**
 * A new endpoint's address, as the author typed it, made plain: a leading `/api/` added when missing, its trailing
 * slash dropped. Null when it cannot be one (see newEndpointProblem for why).
 */
export function newEndpointRoute(typed: string): string | null {
  let route = typed.trim();
  if (!route) return null;
  if (!route.startsWith('/')) route = `/${route}`;
  if (!route.startsWith(ENDPOINT_PREFIX) && route !== '/api') route = `/api${route}`;
  route = route.replace(/\/+$/, '');
  return newEndpointProblem(route) ? null : route;
}

/** Why `route` cannot be a new endpoint's address, in the editor's words, or null when it can. */
export function newEndpointProblem(route: string): string | null {
  if (!route.startsWith(ENDPOINT_PREFIX)) return 'An endpoint’s address starts with /api/, which no page of the site can have.';
  const parts = route.slice(ENDPOINT_PREFIX.length).split('/');
  if (!parts[0]) return 'Name the endpoint after /api/, as in /api/search.';
  if (parts.length > MAX_SEGMENTS) return `An endpoint’s address can have at most ${MAX_SEGMENTS} parts after /api/.`;
  for (const part of parts) {
    if (!NEW_SEGMENT.test(part) || part.includes('..')) return `“${part}” cannot be part of an endpoint’s address: use lower-case letters, numbers, hyphens and underscores, starting with a letter or number.`;
  }
  return null;
}

/** Where a new endpoint at `route` is written. */
export const endpointFileFor = (route: string, language: EndpointLanguage): string => `src/routes${route}/+server.${language}`;

/** What a new endpoint starts with: a GET that answers with JSON from the query, and a POST that reads a JSON body. */
export function endpointStarter(route: string, language: EndpointLanguage): string {
  const ts = language === 'ts';
  const handler = ts ? `: RequestHandler` : '';
  return `import { json } from '@sveltejs/kit';
${ts ? `import type { RequestHandler } from './$types';\n` : ''}
// ${route}: an API endpoint of the site's own. It runs on the server, so it needs the Node.js server deployment
// (Site settings, Deployment), unless it answers the same every time and says so with \`export const prerender = true\`.
// Environment variables it reads come from $app/env/private: see https://svelte.dev/docs/kit/routing#server

/** GET ${route}?name=Ana */
export const GET${handler} = ({ url }) => {
	return json({ hello: url.searchParams.get('name') ?? 'world' });
};

/** POST ${route} with a JSON body. */
export const POST${handler} = async ({ request }) => {
	const body = await request.json().catch(() => null);
	if (body === null) return json({ error: 'Send a JSON body.' }, { status: 400 });
	return json({ received: body }, { status: 201 });
};
`;
}

/** What saving or making an endpoint did: its new hash and listing, or why not (`conflict`: it changed meanwhile). */
export type EndpointWrite = { ok: true; hash: string; endpoint: EndpointFile; text?: string } | { ok: false; message: string; conflict?: true };

/** A test request the Endpoints panel sends to the project's preview server. */
export interface EndpointRequest {
  method: EndpointMethod;
  /** The address in the site, with any query: `/api/search?q=chairs`. */
  path: string;
  /** Request headers, in order, as name and value. */
  headers?: Array<[string, string]>;
  /** The request's body, as text; never for GET or HEAD. */
  body?: string;
}

/** What came back from a test request, or why there was no answer. */
export type EndpointResponse =
  | {
      ok: true;
      status: number;
      statusText: string;
      headers: Array<[string, string]>;
      /** The body as text, cut at the tester's limit (1 MB). */
      body: string;
      truncated: boolean;
      /** From sending the request to the last byte read. */
      ms: number;
    }
  | { ok: false; message: string };

/** Request headers typed one per line, as `Name: value`. Lines without a colon are left out. */
export function parseHeaderLines(text: string): Array<[string, string]> {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((l): Array<[string, string]> => {
      const at = l.indexOf(':');
      return at > 0 ? [[l.slice(0, at).trim(), l.slice(at + 1).trim()]] : [];
    });
}

/** A body laid out for reading: JSON indented when it is JSON, anything else as it came. */
export function shownBody(body: string, headers: Array<[string, string]>): { text: string; json: boolean } {
  const type = headers.find(([n]) => n.toLowerCase() === 'content-type')?.[1] ?? '';
  const looks = /json/i.test(type) || /^\s*[[{]/.test(body);
  if (!looks) return { text: body, json: false };
  try {
    return { text: JSON.stringify(JSON.parse(body), null, 2), json: true };
  } catch {
    return { text: body, json: false };
  }
}
