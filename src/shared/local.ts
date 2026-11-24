/** Local model endpoints: shared by the main process, which enforces them, and Settings, which explains them. */

export type LocalToolMode = 'auto' | 'native' | 'constrained-json';

export interface LocalProviderSettings {
  baseURL: string;
  /** Sends project content to a server on another machine. Off unless the user turns it on. */
  allowRemote: boolean;
  /** `auto` follows the model's capability profile. */
  toolMode: LocalToolMode;
  /** The context size the model is loaded with, in tokens. Null reads it from the server when the server reports it. */
  contextWindow: number | null;
  /**
   * The model chosen on each server, by its normalized address (see `localServerKey`). A server with no entry, or an
   * empty one, uses the first model it lists, so switching servers never sends one server's model to another.
   */
  modelsByServer: Record<string, string>;
}

/** Plain connection presets. llama.cpp is the primary runtime; nothing else in the app branches on these. */
export const LOCAL_PRESETS = [
  { id: 'llama.cpp', label: 'llama.cpp', baseURL: 'http://127.0.0.1:8080/v1' },
  { id: 'ollama', label: 'Ollama', baseURL: 'http://127.0.0.1:11434/v1' },
  { id: 'lm-studio', label: 'LM Studio', baseURL: 'http://127.0.0.1:1234/v1' },
  { id: 'mlx', label: 'MLX', baseURL: 'http://127.0.0.1:8000/v1' }
] as const;

export const DEFAULT_LOCAL_SETTINGS: LocalProviderSettings = { baseURL: LOCAL_PRESETS[0].baseURL, allowRemote: false, toolMode: 'auto', contextWindow: null, modelsByServer: {} };

/** The range a typed context size may take. Below the minimum no request the assistant makes can fit. */
export const LOCAL_CONTEXT_MIN = 1024;
export const LOCAL_CONTEXT_MAX = 10_000_000;

/** A usable context size from Settings or a server, or null. A hand-edited settings file can hold anything. */
export function localContextWindow(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= LOCAL_CONTEXT_MIN && value <= LOCAL_CONTEXT_MAX ? value : null;
}

/** A typed context size: empty is automatic, and digits may be grouped by commas in threes ("32,768"). */
export function parseContextSize(text: string): { ok: true; value: number | null } | { ok: false } {
  const t = text.trim();
  if (!t) return { ok: true, value: null };
  if (!/^(\d+|\d{1,3}(,\d{3})+)$/.test(t)) return { ok: false };
  const value = localContextWindow(Number(t.replace(/,/g, '')));
  return value === null ? { ok: false } : { ok: true, value };
}

/**
 * Loopback addresses as normalized by `URL`, which already rewrites forms such as 2130706433 to 127.0.0.1. Only
 * literal addresses count: a name is whatever the resolver says.
 */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === '[::1]' || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(h);
}

export type LocalURLCheck = { ok: true; url: string; remote: boolean } | { ok: false; message: string };

/**
 * Validate and normalize a server URL. Anything off this computer is refused unless `allowRemote` is set,
 * because the assistant sends project content to it.
 */
export function checkLocalBaseURL(raw: string, allowRemote = false): LocalURLCheck {
  let u: URL;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return { ok: false, message: 'Enter a full server URL, such as http://127.0.0.1:8080/v1.' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, message: 'The server URL must start with http:// or https://.' };
  if (u.username || u.password) return { ok: false, message: 'Remove the username and password from the server URL. Use the API key field instead.' };
  if (u.search || u.hash) return { ok: false, message: 'The server URL cannot include a query string or fragment.' };
  // `localhost` counts as this computer here, where nothing can resolve it; before anything is sent, the main process
  // checks that every address it resolves to is this computer (see the local adapter).
  const remote = u.hostname !== 'localhost' && !isLoopbackHost(u.hostname);
  // Strictly true: a hand-edited settings file holding "false" must not count as permission.
  if (remote && allowRemote !== true) return { ok: false, message: `${u.hostname} is not on this computer. Turn on "Allow a server on another machine" to send project content there.` };
  const path = u.pathname.replace(/\/+$/, '') || '/v1';
  return { ok: true, url: `${u.protocol}//${u.host}${path}`, remote };
}

/**
 * The address a server's model choice is kept under: the normalized URL, so `http://127.0.0.1:8080/v1/` and
 * `http://127.0.0.1:8080/v1` are the same server. Null when the address cannot be read at all.
 */
export function localServerKey(baseURL: string): string | null {
  const check = checkLocalBaseURL(baseURL, true);
  return check.ok ? check.url : null;
}

/** The model chosen for the saved server, or '' to use the first one it lists. */
export function localModelFor(local: Pick<LocalProviderSettings, 'baseURL' | 'modelsByServer'>): string {
  const key = localServerKey(local.baseURL);
  const chosen = key && local.modelsByServer && Object.hasOwn(local.modelsByServer, key) ? local.modelsByServer[key] : '';
  return typeof chosen === 'string' ? chosen : '';
}

/**
 * Which cloud provider issued a key: by its prefix, at the length every such key has (a short `sk-proj-local` is
 * someone's own name for a local key), or by the marker every OpenAI secret key carries.
 */
function cloudKeyProvider(token: string): 'OpenAI' | 'Anthropic' | null {
  if (/^sk-ant-\S{33,}$/.test(token)) return 'Anthropic';
  if (/^sk-(proj|svcacct|admin|None)-\S{30,}$/.test(token) || /^sk-\S*T3BlbkFJ/.test(token)) return 'OpenAI';
  return null;
}

/**
 * Why a key cannot be used for a local server, or null when it can. A recognizable OpenAI or Anthropic key is
 * refused: it would be sent to the local server as typed, and that key belongs to a cloud account. Each word of
 * what was pasted is checked, so `Bearer sk-…` or a quoted key is caught too, while keys a local server was
 * started with (`sk-no-key-required`, or `sk-` and random hex) still work.
 */
export function localKeyProblem(key: string | null | undefined): string | null {
  const tokens = String(key ?? '').split(/[\s"'`=:,;()[\]<>{}]+/);
  const provider = tokens.map(cloudKeyProvider).find(Boolean);
  return provider ? `This looks like an ${provider} API key, which is never sent to a local server. Enter the key your local server was started with, or leave the field empty.` : null;
}
