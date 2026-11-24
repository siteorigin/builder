import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, KeyRound, Monitor, Moon, Server, Settings, Shield, Sun, Trash2 } from 'lucide-react';
import type { AppSettings, SettingsPatch, ProviderId } from '@shared/api';
import { api, setState, useStore, confirmDialog } from '../store';
import { Field, Modal, Segmented, Spinner, SwitchRow, Tabs } from '../components/ui';
import { LocalModelSettings, type LocalServerStatus } from './LocalModelSettings';
import { localKeyProblem } from '@shared/local';

/** A connection test's outcome, shown only while what it tested is still what is on screen. */
type TestResult = { signature: string; provider: ProviderId; edits: number; ok: boolean; message: string; draft: boolean };
type KeyNotice = { provider: ProviderId; kind: 'saved' | 'removed' | 'failed'; message?: string };
type ConnectionView = { tone: 'neutral' | 'ready' | 'problem'; icon: ReactNode; title: string; detail?: string };

const errorText = (e: unknown) => (e instanceof Error && e.message ? e.message : 'Something went wrong.');
const withArticle = (word: string) => `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};
const focusById = (id: string) => requestAnimationFrame(() => document.getElementById(id)?.focus());

/** A single choice with a visible label, exposed as one named radio group. */
function ChoiceField({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <div className="field-label" id={`${id}-label`}>
        {label}
      </div>
      {children}
      {hint && (
        <div className="field-hint" id={`${id}-note`}>
          {hint}
        </div>
      )}
    </div>
  );
}

export function SettingsModal() {
  const settings = useStore((s) => s.settings);
  const providers = useStore((s) => s.providers);
  const modal = useStore((s) => s.modal);
  const [tab, setTab] = useState<string>(modal?.kind === 'settings' && modal.tab ? modal.tab : 'general');
  const [keys, setKeys] = useState<Record<ProviderId, string>>({ openai: '', anthropic: '', local: '' });
  const [testing, setTesting] = useState<ProviderId | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const [keyRevision, setKeyRevision] = useState(0);
  // Counts edits to a typed key, so a test result never outlives the text it tested (the key itself is not kept).
  const [keyEdits, setKeyEdits] = useState(0);
  const [keyNotice, setKeyNotice] = useState<KeyNotice | null>(null);
  // One key write at a time, so a second press cannot race the first or clear a newer draft.
  const [keyBusy, setKeyBusy] = useState(false);
  const keyWrite = useRef(false);
  const [replacing, setReplacing] = useState<Partial<Record<ProviderId, boolean>>>({});
  // Per provider: whether the model is typed as a custom ID. Unset follows the saved model (an unlisted ID
  // shows as typed text until the user asks for the list).
  const [customMode, setCustomMode] = useState<Partial<Record<ProviderId, boolean>>>({});
  const [modelDrafts, setModelDrafts] = useState<Partial<Record<ProviderId, string>>>({});
  useEffect(() => void api.ai.providers().then((p) => setState({ providers: p })), []);
  const updateSettings = useCallback(async (patch: SettingsPatch) => setState({ settings: await api.app.setSettings(patch) }), []);
  // Opened straight to a section (from chat, say), focus starts on that section's tab rather than the first one.
  const loaded = !!settings;
  useEffect(() => {
    if (loaded) document.getElementById(`settings-tab-${tab}`)?.focus();
    // Only when the dialog first has content: later tab changes move focus themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);
  if (!settings) return null;
  const unsavedProviders = (Object.keys(keys) as ProviderId[]).filter((p) => keys[p].trim());
  // A pasted key is never dropped silently: closing with one typed asks first. Save keeps every typed key
  // (for each provider), Discard drops them, and dismissing the question keeps Settings open.
  const close = () => {
    if (keyWrite.current) return;
    // A typed model ID counts as entered even if the field still has focus (Escape closes without a blur).
    if (custom) commitModelDraft();
    closeKeys();
  };
  const closeKeys = () =>
    unsavedProviders.length
      ? void confirmDialog({
          title: unsavedProviders.length > 1 ? 'Save the API keys you entered?' : 'Save the API key you entered?',
          body: `You typed ${unsavedProviders.length > 1 ? 'keys' : 'a key'} for ${unsavedProviders.map((p) => providers.find((x) => x.id === p)?.label ?? p).join(' and ')} but didn’t save ${unsavedProviders.length > 1 ? 'them' : 'it'}.`,
          // The overwrite is named from the providers whose saved key would be replaced, not from how many were typed.
          details: ((replaced: string[]) =>
            replaced.length
              ? [
                  { kind: 'risk' as const, text: `Save and close replaces the ${replaced.length > 1 ? 'keys' : 'key'} saved now for ${replaced.join(' and ')}. Using ${replaced.length > 1 ? 'an old one' : 'the old one'} again takes a copy of it.` },
                  { kind: 'keep' as const, text: 'Discard closes Settings and drops what you typed. Saved keys stay as they are.' }
                ]
              : [
                  { kind: 'note' as const, text: `Save and close keeps ${unsavedProviders.length > 1 ? 'them' : 'it'} on this computer.` },
                  { kind: 'lose' as const, text: 'Discard closes Settings and drops what you typed.' }
                ])(unsavedProviders.filter((p) => providers.find((x) => x.id === p)?.source === 'stored').map((p) => providers.find((x) => x.id === p)?.label ?? p)),
          confirmLabel: 'Save and close',
          cancelLabel: 'Discard',
          stayLabel: 'Keep editing',
          icon: 'key'
        }).then(async (ok) => {
          if (ok === null) return;
          if (ok) {
            for (const p of unsavedProviders) {
              const submitted = keys[p].trim();
              try {
                setState({ providers: await api.ai.setKey(p, submitted) });
                setKeys((k) => (k[p].trim() === submitted ? { ...k, [p]: '' } : k));
              } catch (e) {
                // Settings stays open on the key that failed, still typed, and says why.
                setKeyNotice({ provider: p, kind: 'failed', message: errorText(e) });
                setTab('ai');
                if (p !== provider) await update({ ai: { provider: p } });
                focusById('settings-api-key');
                return;
              }
            }
          }
          setState({ modal: null });
        })
      : setState({ modal: null });
  const update = updateSettings;
  const provider = settings.ai.provider ?? 'openai';
  const status = providers.find((p) => p.id === provider);
  const model = settings.ai.models[provider];
  const known = !!status?.models.some((m) => m.id === model);
  // A new custom ID needs Developer mode; a saved ID that is not in the list can always be edited.
  const canTypeModel = settings.developerMode || (!!status && !known);
  const custom = canTypeModel && (customMode[provider] ?? (!!status && !known));
  const modelDraft = modelDrafts[provider] ?? model;
  const setModel = (id: string) => update({ ai: { models: { ...settings.ai.models, [provider]: id } } });
  const commitModelDraft = () => {
    const id = modelDraft.trim();
    if (id && id !== model) void setModel(id);
    // An emptied field goes back to showing the saved model.
    if (!id) setModelDrafts({ ...modelDrafts, [provider]: undefined });
  };
  // The saved model stays in use (and in the list) until another one is picked.
  const chooseFromList = () => {
    setCustomMode({ ...customMode, [provider]: false });
    setModelDrafts({ ...modelDrafts, [provider]: undefined });
    focusById('settings-model');
  };
  const isLocal = provider === 'local';
  const saveKey = async () => {
    if (keyWrite.current) return;
    const submitted = keys[provider].trim();
    // A test that passed on exactly this typed key still holds once it is saved.
    const passed = test?.ok && test.draft && test.signature === signatureFor() ? test : null;
    keyWrite.current = true;
    setKeyBusy(true);
    try {
      setState({ providers: await api.ai.setKey(provider, submitted) });
    } catch (e) {
      setKeyNotice({ provider, kind: 'failed', message: errorText(e) });
      return;
    } finally {
      keyWrite.current = false;
      setKeyBusy(false);
    }
    // Only what was submitted is cleared: anything typed while it saved stays as a new draft.
    setKeys((k) => (k[provider].trim() === submitted ? { ...k, [provider]: '' } : k));
    setReplacing({ ...replacing, [provider]: false });
    setKeyRevision((n) => n + 1);
    setKeyNotice({ provider, kind: 'saved' });
    if (passed) setTest({ ...passed, draft: false, signature: signatureFor(undefined, 0, 'saved', keyRevision + 1) });
    void update({ ai: { setupAcknowledged: true } });
    focusById('settings-key-replace');
  };
  const removeKey = async () => {
    if (keyWrite.current) return;
    const label = status?.label ?? provider;
    const ok = await confirmDialog({
      title: isLocal ? 'Remove the server API key?' : `Remove the ${label} API key?`,
      body: isLocal ? 'The key is deleted from this computer, and the assistant stops sending one to your model server.' : `The key is deleted from this computer, and the assistant stops working with ${label} until you add one again.`,
      details: [...(isLocal ? [] : [{ kind: 'note' as const, text: `Without a copy of the key, you’ll need to create a new one at ${label}.` }]), { kind: 'final', text: 'This can’t be undone.' }],
      confirmLabel: 'Remove key',
      cancelLabel: 'Keep key',
      tone: 'danger',
      icon: 'key'
    });
    if (!ok || keyWrite.current) return;
    keyWrite.current = true;
    setKeyBusy(true);
    try {
      setState({ providers: await api.ai.setKey(provider, null) });
    } catch (e) {
      setKeyNotice({ provider, kind: 'failed', message: errorText(e) });
      return;
    } finally {
      keyWrite.current = false;
      setKeyBusy(false);
    }
    setKeyRevision((n) => n + 1);
    setKeyNotice({ provider, kind: 'removed' });
    focusById('settings-api-key');
  };
  // A local server counts as configured with no key, so the saved-key controls check the source instead.
  const keySaved = isLocal ? !!status?.source : !!status?.configured;
  const keyFromEnvironment = status?.source === 'environment';
  const keyUrl = provider === 'anthropic' ? 'https://console.anthropic.com/settings/keys' : 'https://platform.openai.com/api-keys';
  const unsavedKey = !!keys[provider].trim();
  const enteringKey = !keySaved || !!replacing[provider] || unsavedKey;
  // A cloud provider's key typed for a local server is refused here and again by the main process, which never stores it.
  const keyProblem = isLocal && enteringKey ? localKeyProblem(keys.local) : null;
  const label = status?.label ?? provider;
  // The model a test would use: a typed ID counts, though chat keeps the saved one until it is committed.
  const testedModel = custom && !isLocal ? modelDraft.trim() : model;
  const modelLabelFor = (id: string) => status?.models.find((m) => m.id === id)?.label ?? id;
  const modelLabel = modelLabelFor(model);
  const signatureFor = (server?: LocalServerStatus, revision = server?.revision ?? 0, keyState: string | number = unsavedKey ? keyEdits : 'saved', savedKey = keyRevision) =>
    [provider, server?.url ?? '', testedModel, revision, savedKey, keyState].join('\n');

  const runTest = async (server?: LocalServerStatus) => {
    setTesting(provider);
    setKeyNotice(null);
    const draft = unsavedKey;
    const outcome = { provider, edits: keyEdits, draft };
    let signature = signatureFor(server);
    try {
      // A local test reads the server's list first, so its result and the model menu agree. A typed key skips
      // that: the list is fetched with the saved key, which may be the one the server just rejected.
      if (server && !draft) signature = signatureFor(server, await server.refresh());
      // What is on screen is what gets tested: a typed but unsaved key, and a typed model ID.
      const r = await api.ai.testProvider(provider, keys[provider].trim() || undefined, custom && !isLocal ? modelDraft.trim() || undefined : undefined);
      setTest({ ...outcome, signature, ok: r.ok, message: r.message });
    } catch (e) {
      setTest({ ...outcome, signature, ok: false, message: errorText(e) });
    } finally {
      setTesting(null);
    }
  };

  const currentKey = keyFromEnvironment ? 'the key from your environment' : 'the saved key';
  /**
   * What the assistant can do right now with what is on screen, and the next step if it cannot. Only a test
   * that passed earns a check: a saved key or a server that answered has not yet been shown to work.
   */
  const connectionView = (server?: LocalServerStatus): ConnectionView => {
    const notice = keyNotice?.provider === provider ? keyNotice : null;
    const result = test?.signature === signatureFor(server) ? test : null;
    const busy = (title: string, detail?: string): ConnectionView => ({ tone: 'neutral', icon: <Spinner decorative />, title, detail });
    const problem = (title: string, detail?: string): ConnectionView => ({ tone: 'problem', icon: <CircleAlert />, title, detail });
    const passed = (title: string, detail?: string): ConnectionView => ({ tone: 'ready', icon: <CircleCheck />, title, detail });
    const neutral = (title: string, detail?: string, icon: ReactNode = <Info />): ConnectionView => ({ tone: 'neutral', icon, title, detail });

    if (testing === provider) return busy('Testing the connection…', isLocal ? server?.url : modelLabelFor(testedModel));
    if (notice?.kind === 'failed') return problem('Could not update the key', notice.message);
    if (server?.phase === 'invalid') return neutral(server.url ? 'Still using the saved server' : 'No server in use yet', server.url || 'Enter a valid address to connect.');
    if (server?.phase === 'pending') return neutral('New address not applied yet', server.url ? `Still using ${server.url}.` : 'Apply it to connect.');
    if (server?.phase === 'checking') return busy('Checking the server…', server.url);
    if (replacing[provider] && !unsavedKey && !server) return neutral(`Replacing your ${label} key`, `Chat keeps using ${currentKey} until you save a new one.`, <KeyRound />);
    if (result && !result.ok) return problem('Connection failed', result.draft ? `${result.message} This key is not saved yet.` : result.message);
    if (result?.ok && result.draft) return passed('This key works', 'Press Save key to use it in chat.');
    if (result?.ok) return passed('Connection test passed', server ? result.message.replace(/^Connected\.\s*/, '') : `${modelLabelFor(testedModel)} responded.`);
    if (keyProblem) return problem('This key cannot be used here', keyProblem);
    if (unsavedKey) return neutral('Key not saved yet', keySaved ? `Chat keeps using ${currentKey} until you save this one.` : 'Press Save key or Enter to use it in chat.', <KeyRound />);
    // A local server's own state says more than its key does, so only hosted providers report the save here.
    if (notice?.kind === 'saved' && !server) return neutral(`${label} key saved`, `${modelLabel}. Test the connection to make sure it works.`, <KeyRound />);
    if (server?.phase === 'unreachable') {
      if (server.reason === 'auth') return problem('The server needs an API key', 'Add or check it under Advanced server options.');
      if (server.reason === 'offline') return problem("Can't reach the server", server.remote ? `Nothing answered at ${server.url}. Check that the server is running and that this computer can reach it.` : `Nothing answered at ${server.url}. Start the server in your model app, load a model, then try again.`);
      return problem("Can't use the server", server.message);
    }
    if (server?.phase === 'empty') return problem('No models loaded', 'Load a model in your server app, then refresh.');
    if (server?.phase === 'ready') {
      if (server.missing) return problem(`${model} is not on this server`, 'Choose one of its models.');
      return neutral('Server reachable', `${hostOf(server.url)} · ${server.models} ${server.models === 1 ? 'model' : 'models'}. Test it to make sure it works.`, <Server />);
    }
    if (notice?.kind === 'removed' && !status?.configured) return neutral(`${label} key removed`, 'Add a key to use the assistant.', <KeyRound />);
    if (status?.configured && keyFromEnvironment) return neutral(`Using your environment's ${label} key`, `${modelLabel}. Test the connection to make sure it works.`);
    if (status?.configured) return neutral(`${label} is set up`, `${modelLabel}. Test the connection to make sure it works.`);
    return neutral(`Add ${withArticle(label)} API key`, 'The assistant needs a key to work. The rest of the editor works without one.', <KeyRound />);
  };

  const connection = (server?: LocalServerStatus) => {
    const view = connectionView(server);
    const testAction = { label: unsavedKey && keySaved ? 'Test new key' : unsavedKey ? 'Test this key' : 'Test connection', run: () => void runTest(server) };
    // The one action that moves this state forward, if there is one.
    const action: { label: string; run?: () => void } | null = !server
      ? (replacing[provider] && !unsavedKey) || !(status?.configured || unsavedKey)
        ? null
        : testAction
      : unsavedKey && (server.phase === 'ready' || server.phase === 'unreachable' || server.phase === 'empty')
        ? testAction
        : server.phase === 'invalid'
          ? server.url
            ? { label: 'Use saved address', run: server.revert }
            : null
          : server.phase === 'pending'
            ? { label: 'Use this address', run: server.apply }
            : server.phase === 'checking'
              ? { label: 'Checking…' }
              : server.phase === 'unreachable'
                ? server.reason === 'auth'
                  ? { label: keySaved ? 'Edit server key' : 'Add server key', run: server.openKey }
                  : { label: 'Try again', run: () => void server.refresh() }
                : server.phase === 'empty'
                  ? { label: 'Refresh models', run: () => void server.refresh() }
                  : server.phase === 'ready' && server.missing
                    ? { label: 'Choose a model', run: () => focusById('settings-local-model') }
                    : testAction;
    // Stays mounted and focusable while busy, so a keyboard user keeps their place through a retry.
    const busy = !!testing || !action?.run;
    return (
      <div className={`settings-status ${view.tone}`}>
        <div className="settings-status-text" role="status" id="settings-connection">
          {view.icon}
          <div className="grow">
            <div className="settings-status-title">{view.title}</div>
            {view.detail && <div className="settings-status-detail">{view.detail}</div>}
          </div>
        </div>
        {action && (
          <button className="btn btn-sm" aria-disabled={busy || undefined} title={unsavedKey ? 'Tests the key you typed. Press Save key to keep it.' : undefined} onClick={busy ? undefined : action.run}>
            {testing ? 'Testing…' : action.label}
          </button>
        )}
      </div>
    );
  };

  // A key that just failed its test can still be saved, but is no longer the suggested next step.
  const draftFailed = unsavedKey && !!test && !test.ok && test.draft && test.provider === provider && test.edits === keyEdits;
  const keyField = status && (
    <Field
      controlId={enteringKey ? 'settings-api-key' : undefined}
      label={isLocal ? 'API key (optional)' : `${status.label} API key`}
      error={keyProblem}
      hint={
        isLocal
          ? 'Only needed if your server asks for one.'
          : keyFromEnvironment && !enteringKey
          ? 'This development build is reading the key from your environment.'
          : 'Kept on this computer where only your user account can read it. It is never put in your projects, exports or logs.'
      }
    >
      {enteringKey ? (
        <>
          <div className="row">
            <input
              id="settings-api-key"
              aria-describedby="settings-api-key-note settings-connection"
              aria-invalid={keyProblem ? true : undefined}
              className="input grow mono"
              type="password"
              autoComplete="off"
              placeholder={isLocal ? 'Paste a key' : provider === 'openai' ? 'sk-…' : 'sk-ant-…'}
              value={keys[provider]}
              onChange={(e) => {
                setKeys({ ...keys, [provider]: e.target.value });
                setKeyEdits((n) => n + 1);
                setKeyNotice(null);
              }}
              onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && keys[provider].trim() && !keyProblem && void saveKey()}
            />
            {replacing[provider] && (
              <button
                className="btn"
                onClick={() => {
                  setKeys({ ...keys, [provider]: '' });
                  setReplacing({ ...replacing, [provider]: false });
                  focusById('settings-key-replace');
                }}
              >
                Cancel
              </button>
            )}
            <button className={`btn${unsavedKey && !draftFailed && !keyProblem ? ' btn-primary' : ''}`} disabled={!unsavedKey || !!keyProblem} aria-disabled={keyBusy || undefined} onClick={() => void saveKey()}>
              {keyBusy ? 'Saving key…' : 'Save key'}
            </button>
          </div>
          {!isLocal && (
            <button className="link-btn settings-key-help" onClick={() => void api.app.openExternal(keyUrl)}>
              Where do I get {withArticle(status.label)} key?
            </button>
          )}
        </>
      ) : (
        <div className="settings-key-saved">
          <KeyRound aria-hidden="true" />
          <span className="grow">{keyFromEnvironment ? 'From your environment' : 'Saved on this computer'}</span>
          <button
            id="settings-key-replace"
            className="btn btn-sm"
            onClick={() => {
              setReplacing({ ...replacing, [provider]: true });
              focusById('settings-api-key');
            }}
          >
            {keyFromEnvironment ? 'Use a different key' : 'Replace'}
          </button>
          {!keyFromEnvironment && (
            <button className="btn btn-sm btn-danger" onClick={() => void removeKey()}>
              <Trash2 /> Remove
            </button>
          )}
        </div>
      )}
      {isLocal && (
        <span className="sr-only" role="status">
          {keyNotice?.provider === 'local' && keyNotice.kind === 'saved' ? 'Server key saved.' : keyNotice?.provider === 'local' && keyNotice.kind === 'removed' ? 'Server key removed.' : ''}
        </span>
      )}
    </Field>
  );

  return (
    <Modal
      title="Settings"
      icon={<Settings />}
      onClose={close}
      footer={
        <>
          <span className="settings-foot-note">Most changes apply right away. API keys are saved separately.</span>
          <span className="spacer" />
          <button className="btn" onClick={close}>
            Close
          </button>
        </>
      }
    >
      <div className="settings-body">
        <Tabs
          value={tab}
          onChange={setTab}
          label="Settings sections"
          idBase="settings"
          panelClassName="settings-panel"
          options={[
            {
              value: 'general',
              label: 'General',
              panel: () => (
                <>
                  <ChoiceField id="settings-appearance" label="Appearance" hint="Changes how SiteOrigin Builder looks. Your website's colors are set in Site styles.">
                    <Segmented<AppSettings['appearance']>
                      radio
                      labelledBy="settings-appearance-label"
                      describedBy="settings-appearance-note"
                      value={settings.appearance}
                      onChange={(appearance) => void update({ appearance })}
                      options={[
                        { value: 'system', label: 'System', icon: <Monitor /> },
                        { value: 'light', label: 'Light', icon: <Sun /> },
                        { value: 'dark', label: 'Dark', icon: <Moon /> }
                      ]}
                    />
                  </ChoiceField>
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
                  <ChoiceField id="settings-provider" label="Provider">
                    <Segmented<ProviderId> radio labelledBy="settings-provider-label" value={provider} onChange={(p) => void update({ ai: { provider: p } })} options={providers.map((p) => ({ value: p.id, label: p.label }))} />
                  </ChoiceField>
                  {isLocal ? (
                    <LocalModelSettings settings={settings} update={update} keyRevision={keyRevision} keySaved={keySaved} revealKey={keyNotice?.provider === 'local' && keyNotice.kind === 'failed'} status={connection} keyField={keyField} />
                  ) : (
                    <>
                      {connection()}
                      {keyField}
                      <Field label="Model" controlId="settings-model">
                        <div className="row">
                          {custom ? (
                            <input
                              id="settings-model"
                              key={provider}
                              className="input grow mono"
                              value={modelDraft}
                              onChange={(e) => setModelDrafts({ ...modelDrafts, [provider]: e.target.value })}
                              // Moving to "Choose from list" leaves the typed ID unsaved, by pointer or by Tab.
                              onBlur={(e) => e.relatedTarget?.id !== 'settings-model-mode' && commitModelDraft()}
                              onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && commitModelDraft()}
                              aria-label="Custom model ID"
                              spellCheck={false}
                            />
                          ) : (
                            <select id="settings-model" key={provider} className="select grow" value={model} onChange={(e) => void setModel(e.target.value)}>
                              {!known && status && <option value={model}>{model} (custom)</option>}
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
                              id="settings-model-mode"
                              className="btn"
                              // Keep focus in the model field so its blur does not save the typed ID on the way to the list.
                              onMouseDown={(e) => custom && e.preventDefault()}
                              onClick={() => {
                                if (custom) chooseFromList();
                                else {
                                  setCustomMode({ ...customMode, [provider]: true });
                                  focusById('settings-model');
                                }
                              }}
                            >
                              {custom ? 'Choose from list' : 'Other model…'}
                            </button>
                          )}
                        </div>
                      </Field>
                    </>
                  )}
                  {!isLocal && (
                    <div className="scope-note info">
                      <Shield />
                      <span>
                        When you use the assistant, your request and the relevant page text and structure are sent to {status?.label ?? 'the provider'}. Images and screenshots are never sent. The provider may charge your account for usage.
                      </span>
                    </div>
                  )}
                  <hr className="settings-rule" />
                  <SwitchRow checked={settings.ai.sendOnEnter} onChange={(v) => void update({ ai: { sendOnEnter: v } })} label="Press Enter to send messages" hint="When off, use ⌘ Enter to send and Enter for a new line." />
                </>
              )
            }
          ]}
        />
      </div>
    </Modal>
  );
}
