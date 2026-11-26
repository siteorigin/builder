import type { ProviderId } from '@shared/api';
import { localModelProfile } from '@shared/local-models';

export { DEFAULT_LOCAL_PROFILE, LOCAL_MODEL_PROFILES, localModelProfile, type LocalModelProfile } from '@shared/local-models';

/** Tested model list. The settings screen also accepts a custom model ID. */
export const PROVIDER_MODELS: Record<ProviderId, Array<{ id: string; label: string; note?: string; contextWindow: number; maxOutput: number }>> = {
  openai: [
    { id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol', note: 'Recommended for everyday writing and edits', contextWindow: 400000, maxOutput: 32000 },
    { id: 'gpt-6.2-astra', label: 'GPT-6.2 Astra', note: 'For complex edits with several requirements', contextWindow: 400000, maxOutput: 32000 },
    { id: 'gpt-6-luna', label: 'GPT-6 Luna', note: 'For small edits you can easily review', contextWindow: 272000, maxOutput: 16000 }
  ],
  anthropic: [
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'Recommended for everyday writing and edits', contextWindow: 200000, maxOutput: 32000 },
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'For short rewrites and wording tweaks', contextWindow: 200000, maxOutput: 16000 },
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'For complex edits with several requirements', contextWindow: 200000, maxOutput: 32000 }
  ],
  // Local models are discovered from the running server.
  local: []
};

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
