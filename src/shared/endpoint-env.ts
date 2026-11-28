/**
 * The environment variables a site's server code reads (#1481), as SvelteKit 3 has them: declared by name in
 * `src/env.js` (its `variables`), and read from `$app/env/private` by the endpoints. Their values are never the
 * project's: on the author's computer they are in `.env` beside the project (a private file no export, saved version or
 * preview serves), and where the site runs, its host sets them. The Endpoints panel keeps the names in
 * `src/env-names.json`, which the `src/env.js` it writes declares, each private, read when the server starts, and
 * optional, so a build with none set (an export's) still succeeds. Shared by the editor and the main process; nothing
 * here touches the disk.
 */

/** Where the panel keeps the names, and the declarations SvelteKit reads that list them. */
export const ENV_NAMES_FILE = 'src/env-names.json';
export const ENV_DECLARATIONS_FILE = 'src/env.js';
/** The local values, beside the project's package.json. */
export const LOCAL_ENV_FILE = '.env';

/** The first line of a `src/env.js` the panel wrote: any other is the developer's own, and is never replaced. */
export const ENV_DECLARATIONS_MARK = '// Written by SiteOrigin Builder from src/env-names.json (Endpoints panel).';

/** The declarations the panel writes: every name in src/env-names.json, private, read at run time, and optional. */
export const ENV_DECLARATIONS = `${ENV_DECLARATIONS_MARK}
// The environment variables the site's server code reads from $app/env/private, as SvelteKit declares them
// (https://svelte.dev/docs/kit/environment-variables). Each is private (never sent to the browser), read when the
// server starts, and optional: an endpoint checks for one it needs. Values come from .env on the computer you edit on,
// which is never exported, and from the host's environment where the site runs. To validate one, replace this file
// with your own declarations: SiteOrigin Builder then leaves it as it is.
import { defineEnvVars } from '@sveltejs/kit/env';
import names from './env-names.json';

export const variables = defineEnvVars(Object.fromEntries(names.map((name) => [name, { schema: (value) => value }])));
`;

/** A variable's name: a letter or underscore, then letters, digits and underscores, as a shell and SvelteKit take one. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Names SvelteKit's adapter-node and Node itself read, which a site's variable must not take. */
const RESERVED = new Set(['PORT', 'HOST', 'ORIGIN', 'SOCKET_PATH', 'XFF_DEPTH', 'ADDRESS_HEADER', 'PROTOCOL_HEADER', 'HOST_HEADER', 'PORT_HEADER', 'BODY_SIZE_LIMIT', 'SHUTDOWN_TIMEOUT', 'IDLE_TIMEOUT', 'KEEP_ALIVE_TIMEOUT', 'HEADERS_TIMEOUT', 'NODE_ENV', 'NODE_OPTIONS', 'PATH', 'HOME', 'TMPDIR', 'LANG']);
/** The words SvelteKit 3 refuses as a variable's name (JavaScript's reserved words, `eval` and `arguments`). */
const JS_RESERVED = new Set(['await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'eval', 'arguments', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'null', 'package', 'private', 'protected', 'public', 'return', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield']);
/**
 * The prefixes of values that go to the browser: SvelteKit's public variables, and Vite's own (`import.meta.env`),
 * which the dev server sends with any page module that reads import.meta.env. A private value takes neither.
 */
const PUBLIC_PREFIXES = ['PUBLIC_', 'VITE_'];

/** The largest value the panel keeps, in characters. */
export const MAX_ENV_VALUE = 8192;
/** The largest .env the panel reads or writes, in bytes. */
export const MAX_DOTENV_BYTES = 1024 * 1024;
/** The most variables the panel lists. */
export const MAX_ENV_NAMES = 100;

/** Why `name` cannot be a variable's name, or null when it can. */
export function envNameProblem(name: string): string | null {
  if (!NAME.test(name)) return 'A variable’s name is letters, numbers and underscores, starting with a letter or underscore, as in SEARCH_API_KEY.';
  if (RESERVED.has(name.toUpperCase())) return `${name} is set by the server or the system itself: choose another name.`;
  if (JS_RESERVED.has(name)) return `${name} is a word JavaScript keeps for itself: choose another name.`;
  const prefix = PUBLIC_PREFIXES.find((p) => name.toUpperCase().startsWith(p));
  if (prefix) return `A name starting with ${prefix} is for values sent to the browser: this panel keeps private ones. Choose another name.`;
  return null;
}

/** Why `value` cannot be kept as a variable's local value, or null when it can. */
export function envValueProblem(value: string): string | null {
  if (value.length > MAX_ENV_VALUE) return `A value can be at most ${MAX_ENV_VALUE} characters.`;
  // eslint-disable-next-line no-control-regex
  if (/[\r\n\u0000]/.test(value)) return 'A value cannot have line breaks.';
  if (value.includes("'") && (value.includes('"') || value.includes('\\n')) && value.includes('`')) return 'A value cannot have single quotes, double quotes and back quotes all at once.';
  return null;
}

/** A variable as the panel shows it: its name, and whether .env gives it a value here. The value itself never leaves the main process. */
export interface EnvVariable {
  name: string;
  /** Whether the project's .env sets it (to anything, an empty value included). */
  local: boolean;
  /** Whether src/env-names.json declares it: one .env sets but nothing declares, no endpoint can read. */
  declared: boolean;
}

/** What the panel shows of the project's environment. */
export interface EndpointEnvironment {
  variables: EnvVariable[];
  /**
   * Who owns src/env.js: `managed` when it is the panel's (or there is none yet), `own` when the developer wrote their
   * own, which the panel never replaces: names added here are then theirs to declare there too.
   */
  declarations: 'managed' | 'own';
}

/** One line of a dotenv file that sets a variable: `NAME=value`, optionally after `export `. */
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;

/**
 * The assignments in a dotenv file's lines, each with the lines it spans: a value in quotes (single, double or back
 * quotes) runs on to the line that closes them, as Node's parseEnv, and so Vite, reads it, so a line inside it is
 * never taken for an assignment of its own.
 */
function assignments(lines: string[]): Array<{ name: string; start: number; end: number }> {
  const out: Array<{ name: string; start: number; end: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = ASSIGNMENT.exec(lines[i]);
    if (!m) continue;
    const value = lines[i].slice(m[0].length).trimStart();
    const quote = value[0];
    let end = i;
    if ((quote === '"' || quote === "'" || quote === '`') && value.indexOf(quote, 1) < 0) {
      const closing = lines.findIndex((l, j) => j > i && l.includes(quote));
      if (closing > 0) end = closing;
    }
    out.push({ name: m[1], start: i, end });
    i = end;
  }
  return out;
}

/** The names a dotenv file's text sets, in order, once each. */
export function dotenvNames(text: string): string[] {
  return [...new Set(assignments(text.split(/\r?\n/)).map((a) => a.name))];
}

/**
 * A value as a dotenv line holds it, for Vite to read back exactly (Node's parseEnv, then dotenv-expand): bare when it
 * can be, else in quotes it has none of (single, then double, then back quotes: parseEnv turns `\n` into a line break
 * only in double quotes), with each `$` escaped, which dotenv-expand would otherwise read as another variable.
 */
function dotenvValue(value: string): string {
  if (/^[A-Za-z0-9_./:@+,=-]*$/.test(value)) return value;
  const v = value.replace(/\$/g, '\\$');
  if (!v.includes("'")) return `'${v}'`;
  if (!v.includes('"') && !v.includes('\\n')) return `"${v}"`;
  return `\`${v}\``;
}

/**
 * A dotenv file's text with `name` set to `value`, or its line removed when `value` is null. Every other line (other
 * variables, comments, blank lines) is kept as it was; a name set on more than one line keeps only its first, changed.
 */
export function setDotenv(text: string, name: string, value: string | null): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(/\r?\n/);
  // The empty string after a final line break is not a line of its own.
  const final = lines.length > 0 && lines[lines.length - 1] === '';
  if (final) lines.pop();
  // Every line an assignment of `name` spans goes, a value over several lines included; the first is replaced.
  const spans = assignments(lines).filter((a) => a.name === name);
  const out: string[] = [];
  let set = false;
  for (let i = 0; i < lines.length; i++) {
    const span = spans.find((a) => i >= a.start && i <= a.end);
    if (!span) out.push(lines[i]);
    else if (i === span.start && value !== null && !set) {
      out.push(`${name}=${dotenvValue(value)}`);
      set = true;
    }
  }
  if (value !== null && !set) out.push(`${name}=${dotenvValue(value)}`);
  return out.length ? out.join(eol) + eol : '';
}

/** The names a src/env-names.json holds: its strings that can be names, once each, in order. */
export function readEnvNames(text: string | null): string[] {
  if (text === null) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((n): n is string => typeof n === 'string' && !envNameProblem(n)))].slice(0, MAX_ENV_NAMES);
  } catch {
    return [];
  }
}

/** src/env-names.json's text for `names`. */
export const envNamesJson = (names: string[]): string => JSON.stringify(names, null, '\t') + '\n';

/** Whether a src/env.js is the panel's own (or there is none, which it may write). */
export const managedDeclarations = (text: string | null): boolean => text === null || text.startsWith(ENV_DECLARATIONS_MARK);

/**
 * The other files SvelteKit takes its declarations from in place of src/env.js (`src/env.ts`, a folder `src/env`
 * with an index, or a file `src/env`): with any of them there, the declarations are the developer's own.
 */
export const OTHER_DECLARATION_FILES = ['src/env.ts', 'src/env', 'src/env/index.js', 'src/env/index.ts'];

/** A change to one variable: declared or not (`declare`), and its local value set or removed (`value`, null removes it). */
export interface EnvChange {
  name: string;
  declare?: boolean;
  value?: string | null;
}
