import { useCallback, useEffect, useState } from 'react';
import { Check, Info, KeyRound, Monitor, Moon, Settings, Shield, Sun } from 'lucide-react';
import type { AppSettings, SettingsPatch, ProviderId } from '@shared/api';
import { api, setState, toast, useStore, confirmDialog } from '../store';
import { Field, Modal, Segmented, SwitchRow, Tabs } from '../components/ui';
import { LocalModelSettings } from './LocalModelSettings';

export function SettingsModal() {
  const settings = useStore((s) => s.settings);
  const providers = useStore((s) => s.providers);
  const modal = useStore((s) => s.modal);
  const [tab, setTab] = useState<string>(modal?.kind === 'settings' && modal.tab ? modal.tab : 'general');
  const [keys, setKeys] = useState<Record<ProviderId, string>>({ openai: '', anthropic: '', local: '' });
  const [testing, setTesting] = useState<ProviderId | null>(null);
  const [keyRevision, setKeyRevision] = useState(0);
  // Per provider: whether the model is typed as a custom ID. Unset follows the saved model (an unlisted ID
  // shows as typed text until the user asks for the list).
  const [customMode, setCustomMode] = useState<Partial<Record<ProviderId, boolean>>>({});
  const [modelDrafts, setModelDrafts] = useState<Partial<Record<ProviderId, string>>>({});
  useEffect(() => void api.ai.providers().then((p) => setState({ providers: p })), []);
  const updateSettings = useCallback(async (patch: SettingsPatch) => setState({ settings: await api.app.setSettings(patch) }), []);
  if (!settings) return null;
  const unsavedProviders = (Object.keys(keys) as ProviderId[]).filter((p) => keys[p].trim());
  // A pasted key is never dropped silently: closing with one typed asks first. Save keeps every typed key
  // (for each provider), Discard drops them, and dismissing the question keeps Settings open.
  const close = () => {
    // A typed model ID counts as entered even if the field still has focus (Escape closes without a blur).
    if (custom) commitModelDraft();
    closeKeys();
  };
  const closeKeys = () =>
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
  const update = updateSettings;
  const provider = settings.ai.provider ?? 'openai';
  const status = providers.find((p) => p.id === provider);
  const model = settings.ai.models[provider];
  const known = !!status?.models.some((m) => m.id === model);
  const custom = customMode[provider] ?? !known;
  const modelDraft = modelDrafts[provider] ?? model;
  const setModel = (id: string) => update({ ai: { models: { ...settings.ai.models, [provider]: id } } });
  const commitModelDraft = () => {
    const id = modelDraft.trim();
    if (id && id !== model) void setModel(id);
    // An emptied field goes back to showing the saved model.
    if (!id) setModelDrafts({ ...modelDrafts, [provider]: undefined });
  };
  const chooseFromList = () => {
    setCustomMode({ ...customMode, [provider]: false });
    setModelDrafts({ ...modelDrafts, [provider]: undefined });
    // The list cannot show an unlisted ID, so switching to it picks the recommended model.
    if (!known && status?.models[0]) void setModel(status.models[0].id);
  };
  const saveKey = async () => {
    setState({ providers: await api.ai.setKey(provider, keys[provider].trim()) });
    setKeys({ ...keys, [provider]: '' });
    setKeyRevision((n) => n + 1);
    void update({ ai: { setupAcknowledged: true } });
    toast('API key saved.', 'success');
  };
  // A local server counts as configured with no key, so the saved-key controls check the source instead.
  const keySaved = provider === 'local' ? !!status?.source : !!status?.configured;
  const keyUrl = provider === 'anthropic' ? 'https://console.anthropic.com/settings/keys' : 'https://platform.openai.com/api-keys';
  const unsavedKey = !!keys[provider].trim();
  const isLocal = provider === 'local';

  return (
    <Modal title="Settings" icon={<Settings />} onClose={close} footer={<button className="btn" onClick={close}>Close</button>}>
      <div className="col" style={{ gap: 16 }}>
        <Tabs
          value={tab}
          onChange={setTab}
          label="Settings sections"
          idBase="settings"
          panelClassName="col"
          panelStyle={{ gap: 18 }}
          options={[
            {
              value: 'general',
              label: 'General',
              panel: () => (
                <>
                  <Field label="Appearance" hint="Changes how SiteOrigin Builder looks. Your website's colors are set in Site styles.">
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
                </>
              )
            },
            {
              value: 'ai',
              label: 'AI assistant',
              panel: () => (
                <>
                  <Field label="Provider">
                    <Segmented<ProviderId>
                      value={provider}
                      onChange={(p) => void update({ ai: { provider: p } })}
                      options={providers.map((p) => ({ value: p.id, label: p.label, icon: p.configured ? <Check /> : undefined }))}
                    />
                  </Field>
                  {isLocal && <LocalModelSettings settings={settings} update={update} keyRevision={keyRevision} />}
                  {status && (
                    <Field
                      controlId="settings-api-key"
                      label={isLocal ? 'API key (optional)' : `${status.label} API key`}
                      hint={
                        isLocal
                          ? 'Only needed if your server asks for one.'
                          : status.configured && status.source === 'environment'
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
                          placeholder={keySaved ? '•••••••••••••••• (saved)' : isLocal ? 'None' : provider === 'openai' ? 'sk-…' : 'sk-ant-…'}
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
                        {keySaved && status.source !== 'environment' && (
                          <button className="btn btn-danger" onClick={async () => {
                              setState({ providers: await api.ai.setKey(provider, null) });
                              setKeyRevision((n) => n + 1);
                            }}>
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
                          !isLocal && (
                            <button className="link-btn" style={{ fontSize: 12 }} onClick={() => void api.app.openExternal(keyUrl)}>
                              Where do I get {/^[aeiou]/i.test(status.label) ? 'an' : 'a'} {status.label} key?
                            </button>
                          )
                        )}
                      </div>
                    </Field>
                  )}
                  {!isLocal && <Field label="Model">
                    <div className="row">
                      {custom ? (
                        <input
                          key={provider}
                          className="input grow mono"
                          value={modelDraft}
                          onChange={(e) => setModelDrafts({ ...modelDrafts, [provider]: e.target.value })}
                          onBlur={commitModelDraft}
                          onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && commitModelDraft()}
                          aria-label="Custom model ID"
                          spellCheck={false}
                        />
                      ) : (
                        <select key={provider} className="select grow" value={model} onChange={(e) => void setModel(e.target.value)} aria-label="Model">
                          {status?.models.map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.label}
                              {m.note ? ` — ${m.note}` : ''}
                            </option>
                          ))}
                        </select>
                      )}
                      {(settings.developerMode || custom || !known) && (
                        <button
                          className="btn"
                          // Keep focus in the model field so its blur does not save the typed ID on the way to the list.
                          onMouseDown={(e) => custom && e.preventDefault()}
                          onClick={() => (custom ? chooseFromList() : setCustomMode({ ...customMode, [provider]: true }))}
                        >
                          {custom ? 'Choose from list' : 'Other model…'}
                        </button>
                      )}
                    </div>
                  </Field>}
                  <div className="row">
                    <button
                      className="btn"
                      disabled={(!status?.configured && !unsavedKey) || !!testing}
                      title={unsavedKey ? 'Tests the key you typed. Press Save to keep it.' : undefined}
                      onClick={async () => {
                        setTesting(provider);
                        // What is on screen is what gets tested: a typed but unsaved key, and a typed model ID.
                        const r = await api.ai.testProvider(provider, keys[provider].trim() || undefined, custom && !isLocal ? modelDraft.trim() || undefined : undefined);
                        setTesting(null);
                        toast(unsavedKey && r.ok ? `${r.message} Press Save to keep this key.` : r.message, r.ok ? 'info' : 'error');
                      }}
                    >
                      {testing ? 'Testing…' : unsavedKey ? 'Test this key' : 'Test connection'}
                    </button>
                  </div>
                  <SwitchRow checked={settings.ai.sendOnEnter} onChange={(v) => void update({ ai: { sendOnEnter: v } })} label="Press Enter to send messages" hint="When off, use ⌘ Enter to send and Enter for a new line." />
                  {!isLocal ? (
                    <div className="scope-note info">
                      <Shield />
                      <span>
                        When you use the assistant, your request and the relevant page text and structure are sent to {status?.label ?? 'the provider'}. Images and screenshots are never sent. The provider may charge your account for usage.
                      </span>
                    </div>
                  ) : (
                    !status?.warning && (
                      <div className="scope-note info">
                        <Shield />
                        <span>Your requests and page content stay on this computer.</span>
                      </div>
                    )
                  )}
                </>
              )
            }
          ]}
        />
      </div>
    </Modal>
  );
}
