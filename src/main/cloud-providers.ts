/**
 * The cloud AI providers' adapters, each imported with its SDK the first time it is used: a launch that never uses AI
 * never evaluates the OpenAI or Anthropic SDK. One that cannot be loaded (a damaged installation) is refused in words a
 * person can act on, and nothing is sent.
 *
 * No electron import: the caller may pass the imports, so this is tested on its own.
 */
import type { AdapterOptions, AgentModelAdapter } from '@agent/types';
import { errorText } from './main-errors';

export type CloudProvider = 'openai' | 'anthropic';

export interface CloudModules {
  openai: () => Promise<Pick<typeof import('@agent/openai'), 'OpenAIAdapter' | 'testOpenAI'>>;
  anthropic: () => Promise<Pick<typeof import('@agent/anthropic'), 'AnthropicAdapter' | 'testAnthropic'>>;
}

const IMPORTS: CloudModules = { openai: () => import('@agent/openai'), anthropic: () => import('@agent/anthropic') };

const NAMES: Record<CloudProvider, string> = { openai: 'OpenAI', anthropic: 'Anthropic' };

/** What a provider that could not be loaded says, in place of an answer. */
export function unloadable(provider: CloudProvider, error: unknown): string {
  return `The ${NAMES[provider]} connection could not be loaded, so nothing was sent. Reinstalling SiteOrigin Builder puts it back. Details: ${errorText(error)}`;
}

export function createCloudProviders(modules: CloudModules = IMPORTS) {
  /** The provider's module, or why it could not be loaded. Only the import is caught: the adapter's own errors are its own. */
  async function load<P extends CloudProvider>(provider: P): Promise<{ module: Awaited<ReturnType<CloudModules[P]>> } | { error: string }> {
    try {
      return { module: (await modules[provider]()) as Awaited<ReturnType<CloudModules[P]>> };
    } catch (e) {
      console.error(`The ${NAMES[provider]} connection could not be loaded:`, e);
      return { error: unloadable(provider, e) };
    }
  }
  return {
    /** An adapter for `provider` with this key and model, or why there is none. */
    async adapter(provider: CloudProvider, key: string, model: string): Promise<{ adapter: AgentModelAdapter } | { error: string }> {
      if (provider === 'openai') {
        const m = await load('openai');
        return 'error' in m ? m : { adapter: new m.module.OpenAIAdapter(key, model) };
      }
      const m = await load('anthropic');
      return 'error' in m ? m : { adapter: new m.module.AnthropicAdapter(key, model) };
    },
    /** Settings' connection test of this key and model. */
    async test(provider: CloudProvider, key: string, model: string, opts: AdapterOptions = {}): Promise<{ ok: boolean; message: string }> {
      if (provider === 'openai') {
        const m = await load('openai');
        return 'error' in m ? { ok: false, message: m.error } : m.module.testOpenAI(key, model, opts);
      }
      const m = await load('anthropic');
      return 'error' in m ? { ok: false, message: m.error } : m.module.testAnthropic(key, model, opts);
    }
  };
}
