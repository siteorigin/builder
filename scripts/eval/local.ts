import type { AgentModelAdapter } from '@agent/types';
import { LocalAdapter, listLocalModels } from '@agent/local';
import { checkLocalBaseURL, DEFAULT_LOCAL_SETTINGS, type LocalToolMode } from '@shared/local';

const TOOL_MODES: LocalToolMode[] = ['auto', 'native', 'constrained-json'];

export interface LocalRunFlags {
  baseURL?: string;
  model?: string;
  toolMode?: string;
  allowRemote?: boolean;
}

/**
 * A benchmark run against a local model server, built the way the app builds one: the same adapter, the same
 * loopback rule, and tool calling chosen by the model's capability profile unless `toolMode` overrides it.
 */
export async function resolveLocalRun(flags: LocalRunFlags, fetchImpl?: typeof globalThis.fetch): Promise<{ model: string; remote: boolean; make: () => AgentModelAdapter }> {
  const toolMode = (flags.toolMode ?? 'auto') as LocalToolMode;
  if (!TOOL_MODES.includes(toolMode)) throw new Error(`Unknown --tool-mode "${flags.toolMode}". Use ${TOOL_MODES.join(', ')}.`);
  const allowRemote = flags.allowRemote === true;
  const url = checkLocalBaseURL(flags.baseURL ?? DEFAULT_LOCAL_SETTINGS.baseURL, allowRemote);
  if (!url.ok) throw new Error(url.message.replace('Turn on “Allow a server on another machine”', 'Pass --allow-remote'));
  let model = flags.model;
  if (!model) {
    // Nothing is sent to another machine before the run is confirmed, not even a model lookup.
    if (url.remote) throw new Error('A server on another machine needs --model.');
    const found = await listLocalModels({ baseURL: url.url }, fetchImpl ? { fetch: fetchImpl } : {});
    if (!found.ok) throw new Error(found.message ?? 'Could not reach the local server.');
    if (!found.models.length) throw new Error('The local server has no models loaded.');
    model = found.models[0];
  }
  const endpoint = { baseURL: url.url, model, allowRemote, toolMode };
  return { model, remote: url.remote, make: () => new LocalAdapter(endpoint, fetchImpl ? { fetch: fetchImpl } : {}) };
}
