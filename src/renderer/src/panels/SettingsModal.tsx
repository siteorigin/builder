import { useEffect, useState } from 'react';
import { Check, Info, KeyRound, Monitor, Moon, Settings, Shield, Sun } from 'lucide-react';
import type { AppSettings, SettingsPatch, ProviderId } from '@shared/api';
import { api, setState, toast, useStore, confirmDialog } from '../store';
import { Field, Modal, Segmented, SwitchRow, Tabs } from '../components/ui';

export function SettingsModal() {
  const settings = useStore((s) => s.settings);
  const providers = useStore((s) => s.providers);
  const modal = useStore((s) => s.modal);
  const [tab, setTab] = useState<string>(modal?.kind === 'settings' && modal.tab ? modal.tab : 'general');
  const [keys, setKeys] = useState<Record<ProviderId, string>>({ openai: '', anthropic: '' });
  const [testing, setTesting] = useState<ProviderId | null>(null);
  const [custom, setCustom] = useState(false);
  // An unlisted saved model shows its ID until the user asks for the list.
  const [listForced, setListForced] = useState(false);
  useEffect(() => void api.ai.providers().then((p) => setState({ providers: p })), []);
  if (!settings) return null;
  const unsavedProviders = (Object.keys(keys) as ProviderId[]).filter((p) => keys[p].trim());
  // A pasted key is never dropped silently: closing with one typed asks first. Save keeps every typed key
  // (for each provider), Discard drops them, and dismissing the question keeps Settings open.
  const close = () =>
    unsavedProviders.length
      ? void confirmDialog({
          title: unsavedProviders.length > 1 ? 'Save the API keys you entered?' : 'Save the API key you entered?',
          body: `You typed ${unsavedProviders.length > 1 ? 'keys' : 'a key'} for ${unsavedProviders.map((p) => providers.find((x) => x.id === p)?.label ?? p).join(' and ')} but did not save ${unsavedProviders.length > 1 ? 'them' : 'it'}.`,
          confirmLabel: 'Save and close',
          cancelLabel: 'Discard',
          stayLabel: 'Keep editing'
        }).then(async (ok) => {
          if (ok === null) return;
          if (ok) for (const p of unsavedProviders) setState({ providers: await api.ai.setKey(p, keys[p].trim()) });
          setState({ modal: null });
        })
      : setState({ modal: null });
  const update = async (patch: SettingsPatch) => setState({ settings: await api.app.setSettings(patch) });
  const provider = settings.ai.provider ?? 'openai';
  const status = providers.find((p) => p.id === provider);
  const model = settings.ai.models[provider];
  const known = status?.models.some((m) => m.id === model);
  const saveKey = async () => {
    setState({ providers: await api.ai.setKey(provider, keys[provider].trim()) });
    setKeys({ ...keys, [provider]: '' });
    void update({ ai: { setupAcknowledged: true } });
    toast('API key saved.', 'success');
  };
  const keyUrl = provider === 'anthropic' ? 'https://console.anthropic.com/settings/keys' : 'https://platform.openai.com/api-keys';
  const unsavedKey = !!keys[provider].trim();

  return (
    <Modal title="Settings" icon={<Settings />} onClose={close} footer={<button className="btn" onClick={close}>Close</button>}>
      <div className="col" style={{ gap: 16 }}>
        <Tabs value={tab} onChange={setTab} label="Settings sections" idBase="settings" options={[{ value: 'general', label: 'General' }, { value: 'ai', label: 'AI assistant' }]} />
        {tab === 'general' ? (
          <div className="col" style={{ gap: 18 }} role="tabpanel" id="settings-panel-general" aria-labelledby="settings-tab-general">
            <Field label="Appearance" hint="Changes how SiteOrigin Builder looks. Your website's colours are set in Site styles.">
              <Segmented<AppSettings['appearance']>
                value={settings.appearance}
                onChange={(appearance) => void update({ appearance })}
                options={[
                  { value: 'system', label: 'System', icon: <Monitor /> },
                  { value: 'light', label: 'Light', icon: <Sun /> },
                  { value: 'dark', label: 'Dark', icon: <Moon /> }
                ]}
              />
            </Field>
            <SwitchRow checked={settings.developerMode} onChange={(v) => void update({ developerMode: v })} label="Developer mode" hint="Shows code components and source views, for people comfortable editing Svelte code. Code is checked before it is saved." />
            <div className="scope-note info">
              <Info />
              <span>Each project keeps your last 100 changes, so you can undo even after reopening it. This history stays on your computer and is never exported.</span>
            </div>
          </div>
        ) : (
          <div className="col" style={{ gap: 18 }} role="tabpanel" id="settings-panel-ai" aria-labelledby="settings-tab-ai">
            <Field label="Provider">
              <Segmented<ProviderId>
                value={provider}
                onChange={(p) => void update({ ai: { provider: p } })}
                options={providers.map((p) => ({ value: p.id, label: p.label, icon: p.configured ? <Check /> : undefined }))}
              />
            </Field>
            {status && (
              <Field
                controlId="settings-api-key"
                label={`${status.label} API key`}
                hint={
                  status.configured && status.source === 'environment'
                    ? 'Using the key from your environment (development build).'
                    : 'Kept on this computer where only your user account can read it. It is never put in your projects, exports or logs.'
                }
              >
                <div className="row">
                  <input
                    id="settings-api-key"
                    aria-describedby="settings-api-key-note"
                    className="input grow mono"
                    type="password"
                    autoComplete="off"
                    placeholder={status.configured ? '•••••••••••••••• (saved)' : provider === 'openai' ? 'sk-…' : 'sk-ant-…'}
                    value={keys[provider]}
                    onChange={(e) => setKeys({ ...keys, [provider]: e.target.value })}
                    onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && keys[provider].trim() && void saveKey()}
                  />
                  <button
                    className="btn"
                    disabled={!keys[provider].trim()}
                    onClick={() => void saveKey()}
                  >
                    <KeyRound /> Save
                  </button>
                  {status.configured && status.source !== 'environment' && (
                    <button className="btn btn-danger" onClick={async () => setState({ providers: await api.ai.setKey(provider, null) })}>
                      Remove
                    </button>
                  )}
                </div>
                <div className="row" style={{ gap: 12, marginTop: 2 }}>
                  {unsavedKey ? (
                    <span className="field-hint" role="status" style={{ color: 'var(--text-2)' }}>
                      Not saved yet. Press Save (or Enter) to keep this key.
                    </span>
                  ) : (
                    <button className="link-btn" style={{ fontSize: 12 }} onClick={() => void api.app.openExternal(keyUrl)}>
                      Where do I get {/^[aeiou]/i.test(status.label) ? 'an' : 'a'} {status.label} key?
                    </button>
                  )}
                </div>
              </Field>
            )}
            <Field label="Model">
              <div className="row">
                {custom || (!known && !listForced) ? (
                  <input className="input grow mono" defaultValue={model} onBlur={(e) => e.target.value.trim() && void update({ ai: { models: { ...settings.ai.models, [provider]: e.target.value.trim() } } })} aria-label="Custom model ID" />
                ) : (
                  <select className="select grow" value={model} onChange={(e) => void update({ ai: { models: { ...settings.ai.models, [provider]: e.target.value } } })} aria-label="Model">
                    {status?.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                        {m.note ? ` — ${m.note}` : ''}
                      </option>
                    ))}
                  </select>
                )}
                {(settings.developerMode || custom || !known) && <button className="btn" onClick={() => (custom || (!known && !listForced) ? (setCustom(false), setListForced(true)) : (setCustom(true), setListForced(false)))}>
                  {custom || (!known && !listForced) ? 'Choose from list' : 'Other model…'}
                </button>}
              </div>
            </Field>
            <div className="row">
              <button
                className="btn"
                disabled={!status?.configured || !!testing}
                onClick={async () => {
                  setTesting(provider);
                  const r = await api.ai.testProvider(provider);
                  setTesting(null);
                  toast(r.message, r.ok ? 'info' : 'error');
                }}
              >
                {testing ? 'Testing…' : 'Test connection'}
              </button>
            </div>
            <SwitchRow checked={settings.ai.sendOnEnter} onChange={(v) => void update({ ai: { sendOnEnter: v } })} label="Press Enter to send messages" hint="When off, use ⌘ Enter to send and Enter for a new line." />
            <div className="scope-note info">
              <Shield />
              <span>
                When you use the assistant, your request and the relevant page text and structure are sent to {status?.label ?? 'the provider'}. Images and screenshots are never sent. The provider may charge your account for usage.
              </span>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
