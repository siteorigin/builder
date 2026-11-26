import { describe, expect, it } from 'vitest';
import { PROVIDER_MODELS } from '@agent/models';

/** What Settings → AI assistant → Model offers: each option reads “label — note”. */
const offered = [...PROVIDER_MODELS.openai, ...PROVIDER_MODELS.anthropic];

describe('the model menu', () => {
  it('offers the models an author can choose, and not the one kept for internal testing', () => {
    expect(PROVIDER_MODELS.openai.map((m) => m.id)).toEqual(['gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6-luna']);
    expect(PROVIDER_MODELS.anthropic.map((m) => m.id)).toEqual(['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5']);
  });

  it('tells an author when to pick each model, in their own terms', () => {
    for (const m of offered) {
      expect(m.note, m.label).toMatch(/\b(for|when)\b/i);
      expect(m.note, m.label).not.toMatch(/harness|test|reliab|smaller|smallest/i);
    }
  });

  it('marks the first model of each provider, the default, as recommended', () => {
    for (const provider of ['openai', 'anthropic'] as const) expect(PROVIDER_MODELS[provider][0].note).toMatch(/^Recommended/);
  });
});
