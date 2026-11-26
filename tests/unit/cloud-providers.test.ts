import { describe, expect, it, vi } from 'vitest';
import { createCloudProviders, type CloudModules } from '../../src/main/cloud-providers';

/** Provider modules that record what was imported and made, with an OpenAI that cannot be loaded when `broken`. */
function modules(broken = false) {
  const imported: string[] = [];
  const made: string[] = [];
  const m: CloudModules = {
    openai: async () => {
      imported.push('openai');
      if (broken) throw new Error("Cannot find package 'openai'");
      return {
        OpenAIAdapter: class {
          constructor(key: string, model: string) {
            made.push(`openai ${key} ${model}`);
          }
        } as never,
        testOpenAI: async (key: string, model: string) => ({ ok: true, message: `openai ${key} ${model}` })
      };
    },
    anthropic: async () => {
      imported.push('anthropic');
      return {
        AnthropicAdapter: class {
          constructor(key: string, model: string) {
            made.push(`anthropic ${key} ${model}`);
          }
        } as never,
        testAnthropic: async (key: string, model: string) => ({ ok: true, message: `anthropic ${key} ${model}` })
      };
    }
  };
  return { m, imported, made };
}

describe('the cloud AI providers', () => {
  it('imports a provider only when it is first used, and only that one', async () => {
    const { m, imported, made } = modules();
    const providers = createCloudProviders(m);
    expect(imported).toEqual([]);
    const r = await providers.adapter('anthropic', 'k', 'claude');
    expect('adapter' in r).toBe(true);
    expect(imported).toEqual(['anthropic']);
    expect(made).toEqual(['anthropic k claude']);
    await expect(providers.test('openai', 'k2', 'gpt')).resolves.toEqual({ ok: true, message: 'openai k2 gpt' });
    expect(imported).toEqual(['anthropic', 'openai']);
  });

  it('says a provider that cannot be loaded could not be, and sends nothing', async () => {
    const { m, made } = modules(true);
    const providers = createCloudProviders(m);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const r = await providers.adapter('openai', 'k', 'gpt');
      expect(r).toEqual({ error: expect.stringContaining('The OpenAI connection could not be loaded, so nothing was sent.') });
      expect((r as { error: string }).error).toContain("Cannot find package 'openai'");
      const t = await providers.test('openai', 'k', 'gpt');
      expect(t.ok).toBe(false);
      expect(t.message).toContain('The OpenAI connection could not be loaded');
      expect(made).toEqual([]);
    } finally {
      quiet.mockRestore();
    }
  });

  it('leaves an adapter’s own error its own', async () => {
    const providers = createCloudProviders({
      ...modules().m,
      anthropic: async () => ({
        AnthropicAdapter: class {
          constructor() {
            throw new Error('Bad model');
          }
        } as never,
        testAnthropic: async () => ({ ok: false, message: 'unused' })
      })
    });
    await expect(providers.adapter('anthropic', 'k', 'm')).rejects.toThrow('Bad model');
  });
});
