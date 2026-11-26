import { describe, expect, it } from 'vitest';
import { PROVIDER_MODELS } from '@agent/models';

/** What Settings → AI assistant → Model offers: each option reads “label — note”. */
const offered = [...PROVIDER_MODELS.openai, ...PROVIDER_MODELS.anthropic];

describe('the model menu', () => {
  it('does not offer the model kept for internal testing', () => {
    expect(offered.map((m) => m.id)).not.toContain('gpt-6.1-terra');
  });

  it('still offers the small model authors can choose', () => {
    expect(offered.map((m) => m.id)).toContain('gpt-6-luna');
  });

  it('tells an author when to pick each model, in their own terms', () => {
    for (const m of offered) {
      expect(m.note, m.label).toMatch(/\b(for|when)\b/i);
      expect(m.note, m.label).not.toMatch(/harness|test|reliab|smaller|smallest/i);
    }
  });

  it('keeps the recommended model first, where the default comes from', () => {
    expect(PROVIDER_MODELS.openai[0].id).toBe('gpt-6.2-sol');
    expect(PROVIDER_MODELS.anthropic[0].id).toBe('claude-sonnet-5-5');
    for (const provider of ['openai', 'anthropic'] as const) expect(PROVIDER_MODELS[provider][0].note).toMatch(/^Recommended/);
  });
});
