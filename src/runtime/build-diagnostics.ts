/**
 * What a failed production build threw, as plain data that can cross the build worker's message port.
 * Pure: no Electron or Node imports, so the worker and the main process (and tests) share it.
 */
export interface BuildErrorInfo {
  name?: string;
  message: string;
  stack?: string;
  /** A tool's own error code (`ERR_MODULE_NOT_FOUND`, `PARSE_ERROR`). */
  code?: string;
  /** The Vite or Rollup plugin that raised it. */
  plugin?: string;
  /** The module it was raised for. */
  id?: string;
  loc?: { file?: string; line?: number; column?: number };
  /** The source lines around `loc`, when the tool printed them. */
  frame?: string;
  /** What this error says it was caused by, one level down. */
  cause?: BuildErrorInfo;
}

/** Each error in a chain keeps its own message, so a long stack on the wrapper cannot crowd out the cause. */
export const ERROR_LIMITS = { depth: 5, message: 2000, stack: 3000, frame: 1500, field: 500 };

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

/** A parameter or key whose value is a credential. */
const CREDENTIAL_NAME = /^(?:access_?token|id_?token|refresh_?token|token|api_?key|apikey|key|secret|client_?secret|password|passwd|pwd|auth|authorization|sig|signature)$/i;
const decoded = (name: string) => {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
};
const KEYED = '(?:api[_-]?key|secret|token|password|passwd|pwd)';

/**
 * Credentials a build may echo (a source line in a code frame, a URL it fetched). The build's own environment holds
 * none, but the report is meant to be pasted into a support request. Applied before any text is cut short, so a
 * secret cannot be left half-hidden at the cut, and again when the report is written.
 */
const SECRETS: Array<[RegExp, string | ((...match: string[]) => string)]> = [
  [/\bsk-[A-Za-z0-9_-]{8,}/g, 'sk-…'],
  // An Authorization header's credential, whatever its length.
  [/(\bauthorization["']?\s*[:=]\s*["']?(?:Bearer|Basic)\s+)[^\s"',;]+/gi, '$1…'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 …'],
  // The user and password of a URL, not the query after them.
  [/(:\/\/)[^\s/:@?#]+:[^\s/@?#]+@/g, '$1…@'],
  // A credential in a URL's query, by the parameter's name as it reads once decoded: its value only.
  [/([?&])([^=&?#\s"']+)=([^&?\s#"')]*)/g, (m, sep, name, value) => (value && CREDENTIAL_NAME.test(decoded(name)) ? `${sep}${name}=…` : m)],
  // A credential written into the source as a literal in either kind of quote, whatever the other kind inside it:
  // not an expression that happens to be named like one.
  [new RegExp(`\\b(${KEYED}["']?\\s*[:=]\\s*)"(?:[^"\\\\\\n]|\\\\.)+"`, 'gi'), '$1"…"'],
  [new RegExp(`\\b(${KEYED}["']?\\s*[:=]\\s*)'(?:[^'\\\\\\n]|\\\\.)+'`, 'gi'), "$1'…'"],
  // A literal whose closing quote is not there (the line was cut short): hidden to the end of the line.
  [new RegExp(`\\b(${KEYED}["']?\\s*[:=]\\s*)(["'])((?:(?!\\2)[^\\r\\n])*)$`, 'gim'), '$1$2…']
];
export const maskSecrets = (t: string) => SECRETS.reduce((text, [re, to]) => text.replace(re, to as string), t);

/** A property read that cannot throw: a getter on a thrown value may. */
function read(o: object, key: string): unknown {
  try {
    return (o as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' && v ? clip(maskSecrets(v), max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return String(value);
  } catch {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      // Even that reads a getter (Symbol.toStringTag) the thrown value controls.
      return '[a value that cannot be shown]';
    }
  }
}

/**
 * A printed line that states a failure outright: an exception, a failed request, the framework's own failure notice.
 * The build's output is kept for these first, since progress lines can bury them.
 */
/** A failed request on its own line (`500 GET /contact/ (linked from /)`): it names a route, and says no more. */
export const REQUEST_LINE = /^\s*\[?[45]\d\d\]?\s+(?:(?:GET|HEAD|POST)\s+)?\/\S*(?:\s+\(.*\))?\s*$/;
export const STRONG_ERROR = /^\s*(?:[A-Za-z_$][\w$.]*Error\b|Error\b|error during build\b|FATAL\b)|^\s*(?:[A-Za-z_$][\w$.]*Error:\s*)?\[?[45]\d\d\]?\s+(?:(?:GET|HEAD|POST)\s+)?\/|\bFailed to prerender\b/i;

/**
 * Whatever a build threw (an `Error`, a string, a Vite or Rollup error with plugin, module and location fields, a
 * wrapper with a `cause`), kept as bounded plain data. Circular causes and getters that throw are survived.
 */
export function serializeBuildError(value: unknown, seen: Set<object> = new Set(), depth = 0): BuildErrorInfo {
  if (value === null || typeof value !== 'object') return { message: clip(maskSecrets(describe(value)), ERROR_LIMITS.message) };
  seen.add(value);
  const info: BuildErrorInfo = { message: str(read(value, 'message'), ERROR_LIMITS.message) ?? clip(maskSecrets(describe(value)), ERROR_LIMITS.message) };
  const name = str(read(value, 'name'), ERROR_LIMITS.field);
  if (name) info.name = name;
  const stack = str(read(value, 'stack'), ERROR_LIMITS.stack);
  if (stack) info.stack = stack;
  const code = read(value, 'code');
  const codeText = str(code, ERROR_LIMITS.field) ?? (typeof code === 'number' ? String(code) : undefined);
  if (codeText) info.code = codeText;
  const plugin = str(read(value, 'plugin'), ERROR_LIMITS.field);
  if (plugin) info.plugin = plugin;
  // Svelte's compiler reports `filename` and `start`; Vite and Rollup report `id` and `loc`.
  const id = str(read(value, 'id'), ERROR_LIMITS.field) ?? str(read(value, 'filename'), ERROR_LIMITS.field);
  if (id) info.id = id;
  const where = read(value, 'loc') ?? read(value, 'start');
  if (where && typeof where === 'object') {
    const file = str(read(where, 'file'), ERROR_LIMITS.field);
    const line = num(read(where, 'line'));
    const column = num(read(where, 'column'));
    if (file || line !== undefined) info.loc = { ...(file ? { file } : {}), ...(line !== undefined ? { line } : {}), ...(column !== undefined ? { column } : {}) };
  }
  const frame = str(read(value, 'frame'), ERROR_LIMITS.frame);
  if (frame) info.frame = frame;
  const cause = read(value, 'cause');
  if (cause !== undefined && cause !== null && !(typeof cause === 'object' && seen.has(cause)) && depth + 1 < ERROR_LIMITS.depth) info.cause = serializeBuildError(cause, seen, depth + 1);
  return info;
}

/** The chain from the error that was thrown to the one at its root, outermost first. */
export function errorChain(info: BuildErrorInfo | undefined): BuildErrorInfo[] {
  const chain: BuildErrorInfo[] = [];
  for (let e = info; e && chain.length < ERROR_LIMITS.depth; e = e.cause) chain.push(e);
  return chain;
}

/** Terminal links, colours and cursor movement, which a build prints for a terminal and a dialog cannot show. */
export const stripTerminal = (t: string) =>
  t
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

/** Does a line the build printed state a failure outright? Judged on what it says, not on the colours it was printed in. */
export const statesFailure = (line: string) => {
  const text = stripTerminal(line);
  return STRONG_ERROR.test(text) && !REQUEST_LINE.test(text);
};
