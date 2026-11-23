import type { ProviderId } from '@shared/api';

/** Tested model list. The settings screen also accepts a custom model ID. */
export const PROVIDER_MODELS: Record<ProviderId, Array<{ id: string; label: string; note?: string; contextWindow: number; maxOutput: number }>> = {
  openai: [
    { id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol', note: 'Recommended: fast and economical', contextWindow: 400000, maxOutput: 32000 },
    { id: 'gpt-6.2-astra', label: 'GPT-6.2 Astra', note: 'Most capable, slower', contextWindow: 400000, maxOutput: 32000 },
    { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', note: 'Smaller model for harness testing', contextWindow: 272000, maxOutput: 32000 },
    { id: 'gpt-6-luna', label: 'GPT-6 Luna', note: 'Smallest, lowest reliability', contextWindow: 272000, maxOutput: 16000 }
  ],
  anthropic: [
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'Recommended', contextWindow: 200000, maxOutput: 32000 },
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'Fast and economical', contextWindow: 200000, maxOutput: 16000 },
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'Most capable', contextWindow: 200000, maxOutput: 32000 }
  ],
  // Local models are discovered from the running server.
  local: []
};

/** What the app needs to know about one local model. */
export interface LocalModelProfile {
  toolCalling: 'native' | 'constrained-json';
  contextWindow: number;
  maxOutput: number;
  temperature: number;
}

/** Any model without its own entry: grammar-constrained JSON, which does not depend on its chat template. */
export const DEFAULT_LOCAL_PROFILE: LocalModelProfile = { toolCalling: 'constrained-json', contextWindow: 32768, maxOutput: 8192, temperature: 0.2 };

/** Per-model overrides, first match wins. A model the app ships with is added here as one entry. */
export const LOCAL_MODEL_PROFILES: Array<{ match: RegExp; profile: Partial<LocalModelProfile> }> = [];

export function localModelProfile(id: string, profiles = LOCAL_MODEL_PROFILES): LocalModelProfile {
  return { ...DEFAULT_LOCAL_PROFILE, ...profiles.find((p) => p.match.test(id))?.profile };
}

/**
 * Limits for a model. A custom ID gets a generous output budget, because reasoning models spend part of it
 * thinking; the adapters lower it automatically if the model rejects it.
 */
export function modelInfo(provider: ProviderId, id: string) {
  if (provider === 'local') {
    const p = localModelProfile(id);
    return { id, label: id, contextWindow: p.contextWindow, maxOutput: p.maxOutput };
  }
  return PROVIDER_MODELS[provider].find((m) => m.id === id) ?? { id, label: id, contextWindow: 128000, maxOutput: 32000 };
}
