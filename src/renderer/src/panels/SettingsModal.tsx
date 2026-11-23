import { useEffect, useState } from 'react';
import { Check, KeyRound, Monitor, Moon, Sun } from 'lucide-react';
import type { AppSettings, SettingsPatch, ProviderId } from '@shared/api';
import { api, setState, toast, useStore } from '../store';
import { Field, Modal, Segmented, Switch } from '../components/ui';

export function SettingsModal() {
  const settings = useStore((s) => s.settings);
  const providers = useStore((s) => s.providers);
  const modal = useStore((s) => s.modal);
  const [tab, setTab] = useState<string>(modal?.kind === 'settings' && modal.tab ? modal.tab : 'general');
  const [keys, setKeys] = useState<Record<ProviderId, string>>({ openai: '', anthropic: '' });
  const [testing, setTesting] = useState<ProviderId | null>(null);
  const [custom, setCustom] = useState(false);
  useEffect(() => void api.ai.providers().then((p) => setState({ providers: p })), []);
  if (!settings) return null;
  const close = () => setState({ modal: null });
  const update = async (patch: SettingsPatch) => setState({ settings: await api.app.setSettings(patch) });
  const provider = settings.ai.provider ?? 'openai';
  const status = providers.find((p) => p.id === provider);
  const model = settings.ai.models[provider];
  const known = status?.models.some((m) => m.id === model);

  return (
    <Modal title="Settings" onClose={close} footer={<button className="btn btn-primary" onClick={close}>Done</button>}>
      <div className="col" style={{ gap: 16 }}>
        <Segmented value={tab} onChange={setTab} options={[{ value: 'general', label: 'General' }, { value: 'ai', label: 'AI assistant' }]} />
        {tab === 'general' ? (
          <>
            <Field label="Appearance" hint="Changes the editor only. Your website's colors are set in Site styles.">
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
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <div>Press Enter to send chat messages</div>
                <div className="field-hint">When off, use ⌘ Enter to send and Enter for a new line.</div>
              </div>
              <Switch checked={settings.ai.sendOnEnter} onChange={(v) => void update({ ai: { sendOnEnter: v } })} label="Enter sends" />
            </div>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div>Developer mode</div>
                <div className="field-hint">Shows code components, source views and Convert to code. Only turn this on if you are comfortable editing Svelte code. Saved code is always checked and, when needed, fixed automatically.</div>
              </div>
              <Switch checked={settings.developerMode} onChange={(v) => void update({ developerMode: v })} label="Developer mode" />
            </div>
            <div className="scope-note info">
              <span>Undo history keeps the latest 100 changes per project, stored in the project's private .siteorigin folder. It is never included in exports.</span>
            </div>
          </>
        ) : (
          <>
            <Field label="Provider">
              <Segmented<ProviderId>
                value={provider}
                onChange={(p) => void update({ ai: { provider: p } })}
                options={providers.map((p) => ({ value: p.id, label: p.label, icon: p.configured ? <Check /> : undefined }))}
              />
            </Field>
            {status && (
              <Field
                label={`${status.label} API key`}
                hint={
                  status.configured
                    ? status.source === 'environment'
                      ? 'Using the key from your environment (development build).'
                      : status.source === 'session'
                        ? 'Stored for this session only: no secure storage is available on this system.'
                        : 'Stored securely with your operating system keychain.'
                    : status.storage === 'session-only'
                      ? 'No secure storage is available here, so the key is kept for this session only.'
                      : 'Stored securely with your operating system keychain. Never saved in projects or exports.'
                }
              >
                <div className="row">
                  <input
                    className="input grow mono"
                    type="password"
                    autoComplete="off"
                    placeholder={status.configured ? '•••••••••••••••• (saved)' : provider === 'openai' ? 'sk-…' : 'sk-ant-…'}
                    value={keys[provider]}
                    onChange={(e) => setKeys({ ...keys, [provider]: e.target.value })}
                  />
                  <button
                    className="btn"
                    disabled={!keys[provider].trim()}
                    onClick={async () => {
                      setState({ providers: await api.ai.setKey(provider, keys[provider].trim()) });
                      setKeys({ ...keys, [provider]: '' });
                      void update({ ai: { setupAcknowledged: true } });
                      toast('API key saved.');
                    }}
                  >
                    <KeyRound /> Save
                  </button>
                  {status.configured && status.source !== 'environment' && (
                    <button className="btn btn-danger" onClick={async () => setState({ providers: await api.ai.setKey(provider, null) })}>
                      Remove
                    </button>
                  )}
                </div>
              </Field>
            )}
            <Field label="Model">
              <div className="row">
                {custom || !known ? (
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
                <button className="btn" onClick={() => setCustom(!custom)}>
                  {custom ? 'Use list' : 'Custom ID'}
                </button>
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
            <div className="scope-note site">
              <span>
                When you use the assistant, your request plus relevant page text, structure and component source are sent to {status?.label ?? 'the provider'}. Images and screenshots are never sent. Provider usage may be charged to your account.
              </span>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
