/**
 * What the app knows about local models, shared by the adapter, which budgets a run by it, and the composer, which
 * warns by it: both work out a model's context window here, so they cannot disagree.
 */
import { DEFAULT_LOCAL_CONTEXT_WINDOW } from './local';

/** What the app needs to know about one local model. */
export interface LocalModelProfile {
  toolCalling: 'native' | 'constrained-json';
  /** The context assumed when neither Settings nor the server gives a size. */
  contextWindow: number;
  maxOutput: number;
  temperature: number;
  /** The largest context the model itself takes, named when a server has loaded it with less than its profile. */
  capacity?: { name: string; tokens: number };
}

/** Any model without its own entry: grammar-constrained JSON, which does not depend on its chat template. */
export const DEFAULT_LOCAL_PROFILE: LocalModelProfile = { toolCalling: 'constrained-json', contextWindow: DEFAULT_LOCAL_CONTEXT_WINDOW, maxOutput: 8192, temperature: 0.2 };

/** Per-model overrides, first match wins. A model the app ships with is added here as one entry. */
export const LOCAL_MODEL_PROFILES: Array<{ match: RegExp; profile: Partial<LocalModelProfile> }> = [
  // Qwen3.5-2B, as servers name it: a repository or alias, a GGUF file name with its quantization, or Ollama's
  // `qwen3.5:2b`. Only the last part of a path counts, so a folder never names another model's file. Half the native
  // context keeps llama.cpp's cache (about 12 KiB a token in f16) near 1.5 GiB, within an ordinary laptop's memory.
  {
    match: /(?<![a-z0-9])qwen[-_]?3\.5[-_:]2b(?![a-z0-9])(?![^\\/]*[\\/])/i,
    profile: { contextWindow: 131_072, maxOutput: 16_384, capacity: { name: 'Qwen3.5-2B', tokens: 262_144 } }
  }
];

export function localModelProfile(id: string, profiles = LOCAL_MODEL_PROFILES): LocalModelProfile {
  return { ...DEFAULT_LOCAL_PROFILE, ...profiles.find((p) => p.match.test(id))?.profile };
}

/**
 * The context a run on a local model plans against: the smaller of what the author set and what the server reported,
 * and the profile's size when neither is known (`known` false: it is only assumed).
 */
export function localWindow(configured: number | null | undefined, reported: number | null | undefined, profile: Pick<LocalModelProfile, 'contextWindow'>): { tokens: number; known: boolean } {
  const sizes = [configured, reported].filter((n): n is number => typeof n === 'number');
  return sizes.length ? { tokens: Math.min(...sizes), known: true } : { tokens: profile.contextWindow, known: false };
}
