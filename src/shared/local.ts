/** Local model endpoints: shared by the main process, which enforces them, and Settings, which explains them. */

export type LocalToolMode = 'auto' | 'native' | 'constrained-json';

export interface LocalProviderSettings {
  baseURL: string;
  /** Sends project content to a server on another machine. Off unless the user turns it on. */
  allowRemote: boolean;
  /** `auto` follows the model's capability profile. */
  toolMode: LocalToolMode;
}

/** Plain connection presets. llama.cpp is the primary runtime; nothing else in the app branches on these. */
export const LOCAL_PRESETS = [
  { id: 'llama.cpp', label: 'llama.cpp', baseURL: 'http://127.0.0.1:8080/v1' },
  { id: 'ollama', label: 'Ollama', baseURL: 'http://127.0.0.1:11434/v1' },
  { id: 'lm-studio', label: 'LM Studio', baseURL: 'http://127.0.0.1:1234/v1' },
  { id: 'mlx', label: 'MLX', baseURL: 'http://127.0.0.1:8000/v1' }
] as const;

export const DEFAULT_LOCAL_SETTINGS: LocalProviderSettings = { baseURL: LOCAL_PRESETS[0].baseURL, allowRemote: false, toolMode: 'auto' };

/** Hostnames as normalized by `URL`, which already rewrites forms such as 2130706433 to 127.0.0.1. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === '[::1]' || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(h);
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
  const remote = !isLoopbackHost(u.hostname);
  // Strictly true: a hand-edited settings file holding "false" must not count as permission.
  if (remote && allowRemote !== true) return { ok: false, message: `${u.hostname} is not on this computer. Turn on "Allow a server on another machine" to send project content there.` };
  const path = u.pathname.replace(/\/+$/, '') || '/v1';
  return { ok: true, url: `${u.protocol}//${u.host}${path}`, remote };
}
