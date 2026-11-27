import type { AppSettings, ProviderId, ProviderStatus, SettingsPatch } from '@shared/api';
import { localServerKey } from '@shared/local';
import { PROVIDER_LABELS } from '@shared/turn-model';

/** What the composer's model menu knows about the local server's models: still being asked, or its answer. */
export type LocalListing = { state: 'loading' } | { state: 'listed'; ok: boolean; models: string[]; server?: string };

/** One row of the composer's model menu, before it becomes a menu item. */
export type ModelPickerRow =
  | { kind: 'heading'; provider: ProviderId; label: string }
  /** A model to send the next message to. `id` is null for the local server's own first model (Automatic). */
  | { kind: 'model'; provider: ProviderId; id: string | null; label: string; description?: string; checked: boolean; patch: SettingsPatch }
  /** A provider that cannot take a message yet: choosing it opens its setup in Settings. */
  | { kind: 'setup'; provider: ProviderId; label: string; action: 'Add key' | 'Set up' }
  /** A fact in place of rows, such as the local server still being asked. */
  | { kind: 'info'; provider: ProviderId; label: string };

const ORDER: ProviderId[] = ['openai', 'anthropic', 'local'];

/**
 * The composer's model menu: every provider's models under its name, with a tick on the one the next message goes to.
 * Choosing a model names its provider and model in one change, so the next message goes there at once. A hosted
 * provider with no key, or a local server that is not set up or not answering, keeps its place as one row that opens
 * its setup.
 */
export function modelPickerRows(providers: readonly ProviderStatus[], ai: Pick<AppSettings['ai'], 'provider' | 'models'>, local: LocalListing): ModelPickerRow[] {
  const rows: ModelPickerRow[] = [];
  for (const id of ORDER) {
    const status = providers.find((p) => p.id === id);
    if (!status) continue;
    const label = status.label || PROVIDER_LABELS[id];
    rows.push({ kind: 'heading', provider: id, label });
    const active = ai.provider === id;
    if (id !== 'local') {
      if (!status.configured) {
        rows.push({ kind: 'setup', provider: id, label, action: 'Add key' });
        continue;
      }
      const saved = ai.models[id]?.trim() ?? '';
      for (const m of status.models) rows.push({ kind: 'model', provider: id, id: m.id, label: m.label, description: m.note, checked: active && saved === m.id, patch: { ai: { provider: id, models: { [id]: m.id } } } });
      // A model ID typed in Developer mode is offered with the listed ones, so it is chosen like any other.
      if (saved && !status.models.some((m) => m.id === saved)) rows.push({ kind: 'model', provider: id, id: saved, label: saved, description: 'Custom model ID', checked: active, patch: { ai: { provider: id, models: { [id]: saved } } } });
      continue;
    }
    if (!status.configured) {
      rows.push({ kind: 'setup', provider: id, label, action: 'Set up' });
      continue;
    }
    if (local.state === 'loading') {
      rows.push({ kind: 'info', provider: id, label: 'Asking your local server for its models…' });
      continue;
    }
    // Missing a server, not a key: one that does not answer, or answers with no models, is set up in Settings.
    if (!local.ok || !local.models.length) {
      rows.push({ kind: 'setup', provider: id, label, action: 'Set up' });
      continue;
    }
    // Each server keeps its own choice, so the choice is saved for the server that listed these models.
    const server = local.server ? localServerKey(local.server) : null;
    const choose = (model: string): SettingsPatch => (server ? { ai: { provider: 'local', local: { modelsByServer: { [server]: model } } } } : { ai: { provider: 'local', models: { local: model } } });
    const saved = ai.models.local?.trim() ?? '';
    rows.push({ kind: 'model', provider: id, id: null, label: 'Automatic', description: `The server’s first model, now ${local.models[0]}`, checked: active && !saved, patch: choose('') });
    for (const m of local.models) rows.push({ kind: 'model', provider: id, id: m, label: m, checked: active && saved === m, patch: choose(m) });
    // A saved model the server no longer lists stays chosen, and shown, until another is picked.
    if (saved && !local.models.includes(saved)) rows.push({ kind: 'model', provider: id, id: saved, label: saved, description: 'Not listed by the server now', checked: active, patch: choose(saved) });
  }
  return rows;
}
