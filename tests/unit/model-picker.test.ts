import { describe, expect, it } from 'vitest';
import type { ProviderStatus } from '@shared/api';
import { modelPickerRows, type LocalListing, type ModelPickerRow } from '../../src/renderer/src/lib/modelPicker';

const status = (id: ProviderStatus['id'], configured: boolean, models: ProviderStatus['models'] = []): ProviderStatus => ({ id, label: { openai: 'OpenAI', anthropic: 'Anthropic', local: 'Local model' }[id], configured, source: configured ? 'stored' : null, storage: 'local-file', models });
const OPENAI = [
  { id: 'gpt-a', label: 'GPT A', note: 'Recommended for most edits' },
  { id: 'gpt-b', label: 'GPT B' }
];
const ANTHROPIC = [{ id: 'claude-a', label: 'Claude A' }];
const ai = (provider: 'openai' | 'anthropic' | 'local', models: Partial<Record<'openai' | 'anthropic' | 'local', string>> = {}) => ({ provider, models: { openai: 'gpt-a', anthropic: 'claude-a', local: '', ...models } });
const shape = (rows: ModelPickerRow[]) => rows.map((r) => (r.kind === 'heading' ? `# ${r.label}` : r.kind === 'model' ? `${r.checked ? '✓' : ' '} ${r.provider}:${r.id ?? 'auto'} ${r.label}` : r.kind === 'setup' ? `${r.provider} [${r.action}]` : `${r.provider} (${r.label})`));

describe('the composer’s model menu (#954)', () => {
  it('lists every provider’s models under its name, with one tick on the next message’s model', () => {
    const rows = modelPickerRows([status('openai', true, OPENAI), status('anthropic', true, ANTHROPIC), status('local', true)], ai('anthropic'), { state: 'listed', ok: true, models: ['first-model', 'second-model'], server: 'http://127.0.0.1:1234/v1' });
    expect(shape(rows)).toEqual([
      '# OpenAI',
      '  openai:gpt-a GPT A',
      '  openai:gpt-b GPT B',
      '# Anthropic',
      '✓ anthropic:claude-a Claude A',
      '# Local model',
      '  local:auto Automatic',
      '  local:first-model first-model',
      '  local:second-model second-model'
    ]);
    expect(rows.filter((r) => r.kind === 'model' && r.checked)).toHaveLength(1);
    expect(rows.find((r) => r.kind === 'model' && r.id === 'gpt-a')).toMatchObject({ description: 'Recommended for most edits' });
  });

  it('switches the provider and its model in one change', () => {
    const rows = modelPickerRows([status('openai', true, OPENAI), status('anthropic', true, ANTHROPIC)], ai('anthropic'), { state: 'loading' });
    expect(rows.find((r) => r.kind === 'model' && r.id === 'gpt-b')).toMatchObject({ patch: { ai: { provider: 'openai', models: { openai: 'gpt-b' } } } });
    expect(modelPickerRows([status('anthropic', true, ANTHROPIC)], ai('openai'), { state: 'loading' }).find((r) => r.kind === 'model')).toMatchObject({ checked: false, patch: { ai: { provider: 'anthropic', models: { anthropic: 'claude-a' } } } });
  });

  it('keeps a provider with no key in the menu as one row that opens its setup', () => {
    const rows = modelPickerRows([status('openai', true, OPENAI), status('anthropic', false, ANTHROPIC), status('local', false)], ai('openai'), { state: 'loading' });
    expect(shape(rows).slice(3)).toEqual(['# Anthropic', 'anthropic [Add key]', '# Local model', 'local [Set up]']);
  });

  it('offers a model ID typed in Developer mode with the listed ones, ticked while it is in use', () => {
    const rows = modelPickerRows([status('openai', true, OPENAI)], ai('openai', { openai: 'gpt-custom' }), { state: 'loading' });
    expect(shape(rows)).toEqual(['# OpenAI', '  openai:gpt-a GPT A', '  openai:gpt-b GPT B', '✓ openai:gpt-custom gpt-custom']);
    expect(rows.at(-1)).toMatchObject({ description: 'Custom model ID' });
  });

  it('says the local server is being asked, and asks for setup when it does not answer or lists nothing', () => {
    const providers = [status('local', true)];
    expect(shape(modelPickerRows(providers, ai('local'), { state: 'loading' }))).toEqual(['# Local model', 'local (Asking your local server for its models…)']);
    expect(shape(modelPickerRows(providers, ai('local'), { state: 'listed', ok: false, models: [] }))).toEqual(['# Local model', 'local [Set up]']);
    expect(shape(modelPickerRows(providers, ai('local'), { state: 'listed', ok: true, models: [] }))).toEqual(['# Local model', 'local [Set up]']);
    // A server that answered with an error is not offered, whatever models came with it.
    expect(shape(modelPickerRows(providers, ai('local'), { state: 'listed', ok: false, models: ['first-model'] }))).toEqual(['# Local model', 'local [Set up]']);
  });

  it('ticks Automatic only when no local model is chosen, even when the server’s first model is the one named', () => {
    const listed: LocalListing = { state: 'listed', ok: true, models: ['first-model'], server: 'http://127.0.0.1:1234/v1/' };
    expect(shape(modelPickerRows([status('local', true)], ai('local'), listed))).toEqual(['# Local model', '✓ local:auto Automatic', '  local:first-model first-model']);
    expect(shape(modelPickerRows([status('local', true)], ai('local', { local: 'first-model' }), listed))).toEqual(['# Local model', '  local:auto Automatic', '✓ local:first-model first-model']);
    // Nothing local is ticked while another provider takes the next message.
    expect(shape(modelPickerRows([status('local', true)], ai('openai'), listed))).toEqual(['# Local model', '  local:auto Automatic', '  local:first-model first-model']);
  });

  it('saves a local choice for the server that listed it, and Automatic as no choice', () => {
    const rows = modelPickerRows([status('local', true)], ai('openai'), { state: 'listed', ok: true, models: ['first-model'], server: 'http://127.0.0.1:1234/v1/' });
    expect(rows.find((r) => r.kind === 'model' && r.id === 'first-model')).toMatchObject({ patch: { ai: { provider: 'local', local: { modelsByServer: { 'http://127.0.0.1:1234/v1': 'first-model' } } } } });
    expect(rows.find((r) => r.kind === 'model' && r.id === null)).toMatchObject({ patch: { ai: { provider: 'local', local: { modelsByServer: { 'http://127.0.0.1:1234/v1': '' } } } } });
  });

  it('offers no model from a list another server gave, once the saved server has changed', () => {
    const rows = modelPickerRows([status('local', true)], { ...ai('openai'), local: { baseURL: 'http://127.0.0.1:5678/v1' } }, { state: 'listed', ok: true, models: ['first-model'], server: 'http://127.0.0.1:1234/v1' });
    expect(shape(rows)).toEqual(['# Local model', 'local (Asking your local server for its models…)']);
    // The same server written another way is the same server.
    for (const [saved, listed] of [['http://127.0.0.1:1234/v1/', 'http://127.0.0.1:1234/v1'], ['http://127.0.0.1:1234/v1', 'http://127.0.0.1:1234/v1/']]) {
      const same = modelPickerRows([status('local', true)], { ...ai('openai'), local: { baseURL: saved } }, { state: 'listed', ok: true, models: ['first-model'], server: listed });
      expect(shape(same)).toEqual(['# Local model', '  local:auto Automatic', '  local:first-model first-model']);
    }
  });

  it('keeps a chosen local model the server no longer lists, so the tick is not lost', () => {
    const rows = modelPickerRows([status('local', true)], ai('local', { local: 'gone-model' }), { state: 'listed', ok: true, models: ['first-model'] });
    expect(shape(rows)).toEqual(['# Local model', '  local:auto Automatic', '  local:first-model first-model', '✓ local:gone-model gone-model']);
  });
});
