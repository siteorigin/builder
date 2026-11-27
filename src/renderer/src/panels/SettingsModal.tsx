import './SettingsModal.css';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { TriangleAlert, Check, CircleAlert, CircleDashed, Cloud, ExternalLink, Eye, EyeOff, History, Info, KeyRound, Laptop, Monitor, Moon, Server, Settings, Shield, SlidersHorizontal, Sparkles, Sun, Trash2 } from 'lucide-react';
import type { AppSettings, SettingsPatch, ProviderId } from '@shared/api';
import { api, setState, useStore, confirmDialog, refreshProviders, setProviders } from '../store';
import { Modal, Segmented, Spinner, SwitchRow, Tabs } from '../components/ui';
import { InlineRow, LocalModelSettings, StackedRow, type LocalServerStatus } from './LocalModelSettings';
import { checkLocalBaseURL, keyDoubt, localKeyProblem } from '@shared/local';
import { AskAiShortcut } from './ShortcutSettings';
import { sendOnEnterHint } from '../lib/shortcut-keys';

/** A connection test's outcome, shown only while what it tested is still what is on screen. */
type TestResult = { signature: string; provider: ProviderId; edits: number; ok: boolean; message: string; draft: boolean; stage?: 'server' | 'chat' };
type KeyNotice = { provider: ProviderId; kind: 'saved' | 'removed' | 'failed'; message?: string };
type ConnectionView = { tone: 'neutral' | 'ready' | 'problem' | 'busy'; icon: ReactNode; title: string; detail?: string };

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
/** Focuses a select and opens its list, where the platform allows it. */
const openPicker = (id: string) => {
  const select = document.getElementById(id) as HTMLSelectElement | null;
  select?.focus();
  try {
    select?.showPicker();
  } catch {
    // Opening needs a user gesture some platforms do not see through a frame; focus alone still lands there.
  }
};

export function SettingsModal() {
  const settings = useStore((s) => s.settings);
  // The provider whose settings are on screen. Looking at one never changes the one the assistant uses.
  const [viewed, setViewed] = useState<ProviderId | null>(null);
  const providers = useStore((s) => s.providers);
  const modal = useStore((s) => s.modal);
  const [tab, setTab] = useState<string>(modal?.kind === 'settings' && modal.tab ? modal.tab : 'general');
  const [showKey, setShowKey] = useState(false);
  const [keys, setKeys] = useState<Record<ProviderId, string>>({ openai: '', anthropic: '', local: '' });
  const [testing, setTesting] = useState<ProviderId | null>(null);
  // What the running test was started with, so editing the key or model mid-test shows the new draft as untested.
  const [testingWith, setTestingWith] = useState('');
  // Whether the local server is unreachable or empty, which a typed server key cannot fix.
  const [localBlocked, setLocalBlocked] = useState(false);
  // The local server's state as its card last showed it, for what the rest of the page says about it.
  const [localServer, setLocalServer] = useState<LocalServerStatus | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);
  const [keyRevision, setKeyRevision] = useState(0);
  // Counts edits to each provider's typed key, so a test result never outlives the text it tested (the key itself
  // is not kept), and the edit count at which each provider's typed key last failed a test.
  const [keyEdits, setKeyEdits] = useState<Record<ProviderId, number>>({ openai: 0, anthropic: 0, local: 0 });
  const [failedDrafts, setFailedDrafts] = useState<Partial<Record<ProviderId, number>>>({});
  // Bumped when the provider or model changes, so a result is never shown again for a setup it no longer describes
  // and a test still running for the old one is dropped when it answers.
  const testRun = useRef(0);
  // For a local server, the address and its saved key are part of the setup too.
  const viewedProvider = viewed ?? settings?.ai.provider ?? 'openai';
  const testedSetup = [viewedProvider, settings?.ai.models[viewedProvider] ?? '', viewedProvider === 'local' ? `${settings?.ai.local.baseURL}\n${keyRevision}` : ''].join('\n');
  const lastSetup = useRef(testedSetup);
  useEffect(() => {
    if (lastSetup.current === testedSetup) return;
    lastSetup.current = testedSetup;
    testRun.current += 1;
    setTest(null);
    setTesting(null);
  }, [testedSetup]);
  const [keyNotice, setKeyNotice] = useState<KeyNotice | null>(null);
  // One key write at a time, so a second press cannot race the first or clear a newer draft.
  const [keyBusy, setKeyBusy] = useState(false);
  const keyWrite = useRef(false);
  const [replacing, setReplacing] = useState<Partial<Record<ProviderId, boolean>>>({});
  // Per provider: whether the model is typed as a custom ID. Unset follows the saved model (an unlisted ID
  // shows as typed text until the user asks for the list).
  const [customMode, setCustomMode] = useState<Partial<Record<ProviderId, boolean>>>({});
  const [modelDrafts, setModelDrafts] = useState<Partial<Record<ProviderId, string>>>({});
  useEffect(() => void refreshProviders(), []);
  // Each change can change what Chat shows (the provider, the local server, its model or its last check).
  const updateSettings = useCallback(async (patch: SettingsPatch) => {
    setState({ settings: await api.app.setSettings(patch) });
    void refreshProviders();
  }, []);
  // Opened straight to a section (from chat, say), focus starts on that section's tab rather than the first one.
  const loaded = !!settings;
  useEffect(() => {
    if (loaded) document.getElementById(`settings-tab-${tab}`)?.focus();
    // Only when the dialog first has content: later tab changes move focus themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);
  if (!settings) return null;
  // A cloud key typed for a local server is refused anyway, so it is never offered for saving on close.
  // A key that cannot belong to its provider is questioned before it is saved: by its shape, with no network call.
  const confirmKeyShape = async (p: ProviderId, key: string) => {
    const doubt = keyDoubt(p, key);
    if (!doubt) return true;
    const name = providers.find((x) => x.id === p)?.label ?? p;
    return !!(await confirmDialog({ title: `Save this as the ${name} key?`, body: doubt, details: [{ kind: 'note', text: 'Saving it anyway is fine if you know it is right. A wrong key only shows up later, as a failed request.' }], confirmLabel: 'Save anyway', cancelLabel: 'Keep editing', icon: 'key' }));
  };
  const unsavedProviders = (Object.keys(keys) as ProviderId[]).filter((p) => keys[p].trim() && !(p === 'local' && localKeyProblem(keys.local)));
  const nameOf = (p: ProviderId) => providers.find((x) => x.id === p)?.label ?? p;
  // Typed keys that failed their last test, for whichever provider they were typed under.
  const failedUnsaved = unsavedProviders.filter((p) => failedDrafts[p] === keyEdits[p]);
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
          details: ((replaced: string[]) => [
            // A key that just failed its test is still the user's to keep, but never without saying so.
            ...(failedUnsaved.length ? [{ kind: 'risk' as const, text: `The ${failedUnsaved.map(nameOf).join(' and ')} ${failedUnsaved.length > 1 ? 'keys' : 'key'} you typed failed ${failedUnsaved.length > 1 ? 'their' : 'its'} connection test, so the assistant may not work with ${failedUnsaved.length > 1 ? 'them' : 'it'}.` }] : []),
            ...(replaced.length
              ? [
                  { kind: 'risk' as const, text: `Save and close replaces the ${replaced.length > 1 ? 'keys' : 'key'} saved now for ${replaced.join(' and ')}. Using ${replaced.length > 1 ? 'an old one' : 'the old one'} again takes a copy of it.` },
                  { kind: 'keep' as const, text: 'Discard closes Settings and drops what you typed. Saved keys stay as they are.' }
                ]
              : [
                  { kind: 'note' as const, text: `Save and close keeps ${unsavedProviders.length > 1 ? 'them' : 'it'} on this computer.` },
                  { kind: 'lose' as const, text: 'Discard closes Settings and drops what you typed.' }
                ])
          ])(unsavedProviders.filter((p) => providers.find((x) => x.id === p)?.source === 'stored').map((p) => providers.find((x) => x.id === p)?.label ?? p)),
          confirmLabel: 'Save and close',
          cancelLabel: 'Discard',
          stayLabel: 'Keep editing',
          icon: 'key'
        }).then(async (ok) => {
          if (ok === null) return;
          if (ok) {
            // The same one-write-at-a-time guard as Save key, held until every typed key is saved.
            if (keyWrite.current) return;
            keyWrite.current = true;
            setKeyBusy(true);
            try {
              // Every doubtful key is asked about before any is written, so Keep editing never leaves a partial save.
              for (const p of unsavedProviders) {
                if (!(await confirmKeyShape(p, keys[p].trim()))) {
                  setTab('ai');
                  setViewed(p);
                  setShowKey(false);
                  focusById('settings-api-key');
                  return;
                }
              }
              for (const p of unsavedProviders) {
                const submitted = keys[p].trim();
                try {
                  setProviders(await api.ai.setKey(p, submitted));
                  setKeys((k) => (k[p].trim() === submitted ? { ...k, [p]: '' } : k));
                } catch (e) {
                  // Settings stays open on the key that failed, still typed, and says why.
                  setKeyNotice({ provider: p, kind: 'failed', message: errorText(e) });
                  setTab('ai');
                  setViewed(p);
                  focusById('settings-api-key');
                  return;
                }
              }
            } finally {
              keyWrite.current = false;
              setKeyBusy(false);
            }
          }
          setState({ modal: null });
        })
      : setState({ modal: null });
  const update = updateSettings;
  const activeProvider = settings.ai.provider ?? 'openai';
  const provider = viewed ?? activeProvider;
  const status = providers.find((p) => p.id === provider);
  const model = settings.ai.models[provider];
  const known = !!status?.models.some((m) => m.id === model);
  // A new custom ID needs Developer mode; a saved ID that is not in the list can always be edited.
  const canTypeModel = settings.developerMode || (!!status && !known);
  const custom = canTypeModel && (customMode[provider] ?? (!!status && !known));
  const modelDraft = modelDrafts[provider] ?? model;
  // Only this provider's model: the local one is kept per server, and the screen may not have the latest of it.
  const setModel = (id: string) => update({ ai: { models: { [provider]: id } } });
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
    // A test of exactly this typed key, passed or failed, still describes it once it is saved.
    const tested = test?.draft && test.signature === signatureFor() ? test : null;
    keyWrite.current = true;
    if (!(await confirmKeyShape(provider, submitted))) {
      keyWrite.current = false;
      focusById('settings-api-key');
      return;
    }
    setKeyBusy(true);
    try {
      setProviders(await api.ai.setKey(provider, submitted));
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
    setShowKey(false);
    setKeyNotice({ provider, kind: 'saved' });
    if (tested) setTest({ ...tested, draft: false, signature: signatureFor(undefined, 0, 'saved', keyRevision + 1) });
    void update({ ai: { setupAcknowledged: true } });
    // The field and Save key are gone, so focus moves on to the next step: testing the key, or (when it is already
    // tested) the saved key's own row. Focus the user has already moved elsewhere stays where it is.
    requestAnimationFrame(() => {
      const at = document.activeElement;
      if (at && at !== document.body && at.isConnected) return;
      // A local save starts a new check, so its status action can be busy: the saved key's row is next in line.
      ((tested ? null : document.querySelector<HTMLElement>('.settings-status .btn:not([aria-disabled])')) ?? document.getElementById('settings-key-replace'))?.focus();
    });
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
      setProviders(await api.ai.setKey(provider, null));
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
  const signatureFor = (server?: LocalServerStatus, revision = server?.revision ?? 0, keyState: string | number = unsavedKey ? keyEdits[provider] : 'saved', savedKey = keyRevision) =>
    [provider, server?.url ?? '', testedModel, revision, savedKey, keyState].join('\n');

  const testingNow = testing === provider && testingWith === [provider, keyEdits[provider], testedModel, keyRevision].join('\n');
  // A provider's own words for a key it refused outright, as opposed to a network or model failure.
  const keyRejected = (message: string) => /incorrect api key|invalid[ _-](x-)?api[ _-]key|invalid authentication|unauthori[sz]ed|\b401\b|rejected the api key/i.test(message);

  const runTest = async (server?: LocalServerStatus) => {
    setTesting(provider);
    setTestingWith([provider, keyEdits[provider], testedModel, keyRevision].join('\n'));
    setKeyNotice(null);
    const run = ++testRun.current;
    const draft = unsavedKey;
    const edits = keyEdits[provider];
    const outcome = { provider, edits, draft };
    // A result for a setup that changed while it ran describes nothing on screen.
    const settle = (ok: boolean, message: string, stage?: TestResult['stage']) => {
      if (run !== testRun.current) return;
      setTest({ ...outcome, signature, ok, message, stage });
      if (draft) setFailedDrafts((f) => ({ ...f, [provider]: ok ? undefined : edits }));
    };
    let signature = signatureFor(server);
    // A key this app refuses is never sent anywhere; the test says why instead.
    if (keyProblem) {
      settle(false, keyProblem);
      setTesting(null);
      return;
    }
    try {
      // A local test reads the server's list first, so its result and the model menu agree. A typed key skips
      // that: the list is fetched with the saved key, which may be the one the server just rejected.
      if (server && !draft) signature = signatureFor(server, await server.refresh());
      // The setup changed while the list was read: nothing on screen is waiting for this test any more.
      if (run !== testRun.current) return;
      // What is on screen is what gets tested: a typed but unsaved key, and a typed model ID.
      const r = await api.ai.testProvider(provider, keys[provider].trim() || undefined, custom && !isLocal ? modelDraft.trim() || undefined : undefined);
      settle(r.ok, r.message, r.stage);
      // A local test of the saved setup is what Chat goes by too.
      if (server && !draft) void refreshProviders();
    } catch (e) {
      settle(false, errorText(e));
    } finally {
      if (run === testRun.current) setTesting(null);
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
    const busy = (title: string, detail?: string): ConnectionView => ({ tone: 'busy', icon: <Spinner decorative />, title, detail });
    const problem = (title: string, detail?: string): ConnectionView => ({ tone: 'problem', icon: <CircleAlert />, title, detail });
    const passed = (title: string, detail?: string): ConnectionView => ({ tone: 'ready', icon: <Check />, title, detail });
    const neutral = (title: string, detail?: string, icon: ReactNode = <Info />): ConnectionView => ({ tone: 'neutral', icon, title, detail });
    const untested = (detail: string) => neutral('Not tested yet', detail, <CircleDashed />);

    // A long custom ID is in its own field below; the status names it in words.
    const testedName = status?.models.some((m) => m.id === testedModel) ? modelLabelFor(testedModel) : 'Your custom model';
    // An address waiting to be completed or confirmed is the question on screen, ahead of a test or a key: the
    // status's answers are the address's (see the action below), so its title must be too.
    if (server?.phase === 'invalid' && server.remoteHost)
      return neutral('This server is on another machine', `To use ${server.remoteHost}, turn on ‘Allow a server on another machine’ below.${keySaved ? ' Your saved server key goes to it too.' : ''}${server.url ? ` Until then the saved server is ${hostOf(server.url)}.` : ''}`, <TriangleAlert />);
    if (server?.phase === 'invalid') return neutral(server.url ? 'Still using the saved server' : 'No server in use yet', server.url ? `The saved server, ${hostOf(server.url)}, stays in use until the address below is complete.` : 'Enter a valid address to connect.');
    if (server?.phase === 'pending')
      return neutral(
        server.proposedHost ? `Switch to ${server.proposedHost}?` : 'New address not applied yet',
        server.proposedHost ? `If you switch, ${provider === activeProvider ? 'the assistant sends' : 'Local model will send'} your requests and page content${keySaved ? ', and your saved server key,' : ''} to ${server.proposedHost}. Current server: ${server.url ? hostOf(server.url) : 'none'}.` : server.url ? `Still using ${server.url}.` : 'Apply it to connect.',
        server.proposedHost ? <TriangleAlert /> : undefined
      );
    if (testingNow) return busy('Testing the connection…', isLocal ? `Listing the models at ${server?.url}, then sending ${model || 'the first one'} a short chat request.` : testedName);
    if (notice?.kind === 'failed') return problem('Could not update the key', notice.message);
    if (server?.phase === 'checking') return busy('Checking the server…', server.url);
    if (replacing[provider] && !unsavedKey && !server) return neutral(`Replacing your ${label} key`, `Chat keeps using ${currentKey} until you save a new one.`, <KeyRound />);
    // What happened, in the provider's words; what to do about the key is said at the key. A model the server lists
    // can still fail to chat, which is why a local test sends a request rather than reading the list.
    const failedTitle = result?.stage === 'chat' ? 'The model did not answer' : result?.draft ? 'This key didn’t pass the test' : 'Connection failed';
    if (result && !result.ok) return problem(result.draft && keyRejected(result.message) ? `${isLocal ? 'The server' : label} didn’t accept this key` : failedTitle, result.message);
    if (result?.ok && result.draft) return passed('This key works', 'Save it to use it in chat.');
    if (result?.ok) return passed('Connection test passed', server ? result.message.replace(/^Connected\.\s*/, '') : `${testedName} responded.`);
    if (keyProblem) return problem('This key cannot be used here', keyProblem);
    // A server that is not there, or has nothing loaded, outranks a typed key: the key cannot help with either.
    const serverBlocked = server?.phase === 'empty' || (server?.phase === 'unreachable' && server.reason !== 'auth');
    if (unsavedKey && !serverBlocked) return neutral('Key not saved yet', keySaved ? `Chat keeps using ${currentKey} until you save this one.` : 'Press Save key or Enter to use it in chat.', <KeyRound />);
    // A local server's own state says more than its key does, so only hosted providers report the save here.
    if (notice?.kind === 'saved' && !server) return neutral('Key saved, not tested yet', `Test the connection to check ${known ? modelLabel : 'your custom model'} responds.`, <KeyRound />);
    if (server?.phase === 'unreachable') {
      if (server.reason === 'auth') return problem('The server needs an API key', 'Add or check it under Advanced server options.');
      // Nothing set up yet is not a fault: the usual first visit, before the model app is running.
      if (server.reason === 'offline' && server.firstRun) return neutral('Start your model server', `Nothing is answering at ${hostOf(server.url)} yet. Open your model app, start its server and load a model.`, <Server />);
      if (server.reason === 'offline') return problem('Can’t reach the server', server.remote ? `Nothing answered at ${server.url}. Check that the server is running and that this computer can reach it.` : `Nothing answered at ${server.url}. Start the server in your model app, load a model, then try again.`);
      return problem('Can’t use the server', server.message);
    }
    if (server?.phase === 'empty') return problem('No models loaded', 'Load a model in your server app, then refresh.');
    if (server?.phase === 'ready') {
      if (server.missing) return problem('Your saved model isn’t on this server', `${hostOf(server.url)} doesn’t list ${model}. Choose one of its models.`);
      return neutral('Server reachable, not tested yet', `${hostOf(server.url)} lists ${server.models} ${server.models === 1 ? 'model' : 'models'}. Test the connection to check the model replies.`, <Server />);
    }
    if (notice?.kind === 'removed' && !status?.configured) return neutral(`${label} key removed`, 'Add a key to use the assistant.', <KeyRound />);
    if (status?.configured) return untested(`${known ? modelLabel : 'Your custom model'}, using ${currentKey}.`);
    return neutral(`Add ${withArticle(label)} API key`, 'Already have one? Paste it below. Everything else in the editor works without a key.', <KeyRound />);
  };

  const connection = (server?: LocalServerStatus) => {
    const view = connectionView(server);
    const testAction = { label: unsavedKey ? 'Test this key' : 'Test connection', run: () => void runTest(server) };
    // A key the provider refused outright: testing it again cannot help, a different key can.
    const pasteNew = {
      label: 'Paste a new key',
      run: () =>
        requestAnimationFrame(() => {
          const field = document.getElementById('settings-api-key') as HTMLInputElement | null;
          field?.focus();
          field?.select();
        })
    };
    const refused = draftFailed && !!test && keyRejected(test.message);
    // With no key yet, the next step is getting one.
    const getKey = { label: `Get ${withArticle(label)} key`, run: () => void api.app.openExternal(keyUrl), external: true };
    // The one action that moves this state forward, if there is one.
    const action: { label: string; run?: () => void; external?: boolean } | null = !server
      ? replacing[provider] && !unsavedKey
        ? null
        : !(status?.configured || unsavedKey)
          ? getKey
          : refused
            ? pasteNew
            : testAction
      : // An address waiting to be completed or confirmed is answered first: its question is the status's title.
        server.phase === 'invalid'
        ? server.url
          ? { label: 'Use saved address', run: server.revert }
          : null
        : server.phase === 'pending'
          ? { label: 'Use this address', run: server.apply }
          : refused && !keyProblem
            ? pasteNew
            : // A typed key can only answer a server that is there, or one that asked for a key.
            unsavedKey && (server.phase === 'ready' || (server.phase === 'unreachable' && server.reason === 'auth') || !!keyProblem)
            ? testAction
            : server.phase === 'checking'
              ? { label: 'Checking…' }
              : server.phase === 'unreachable'
                ? server.reason === 'auth'
                  ? { label: keySaved ? 'Edit server key' : 'Add server key', run: server.openKey }
                  : { label: server.firstRun ? 'Check again' : 'Try again', run: () => void server.refresh() }
                : server.phase === 'empty'
                  ? { label: 'Refresh models', run: () => void server.refresh() }
                  : server.phase === 'ready' && server.missing
                    ? { label: 'Choose a model', run: () => requestAnimationFrame(() => openPicker('settings-local-model')) }
                    : testAction;
    // Stays mounted and focusable while busy, so a keyboard user keeps their place through a retry.
    const busy = (testingNow && action === testAction) || !action?.run;
    // The status action is the one primary on the page when it is the next step: not after a pass (a retest is
    // optional), and not while a typed key waits to be saved (Save key is), unless the server itself is the blocker.
    const blocked = !!server && (server.phase === 'empty' || (server.phase === 'unreachable' && server.reason !== 'auth'));
    // Going back to the saved server is offered, never urged: the next step while an address is unapplied is in the field.
    const primary = !busy && view.tone !== 'ready' && (!unsavedKey || blocked) && server?.phase !== 'invalid';
    // A switch to another machine is a question with two answers, kept together.
    const keep = server?.phase === 'pending' && server.proposedHost ? { label: 'Keep current server', run: () => (server.revert(), focusById('settings-local-url')) } : null;
    return (
      <div className={`settings-status ${view.tone}${keep ? ' choice' : ''}`}>
        <span className="settings-status-icon" aria-hidden="true">
          {view.icon}
        </span>
        <div className="settings-status-text" role="status" id="settings-connection">
          <div className="settings-status-title">{view.title}</div>
          {view.detail && <div className="settings-status-detail">{view.detail}</div>}
        </div>
        {/* One container in every state, so the first button stays the same element when a switch is accepted and
            the second answer goes: the keyboard keeps its place on the status's next step. */}
        {action && (
          <div className="settings-status-actions">
            <button
              id="settings-status-action"
              className={`btn${primary ? ' btn-primary' : ''}`}
              aria-disabled={busy || undefined}
              title={action.external ? 'Opens in your browser' : action === testAction && unsavedKey ? 'Tests the key you typed. Press Save key to keep it.' : undefined}
              // A two-answer question: each answer is read with the question it answers.
              aria-describedby={keep ? 'settings-connection' : undefined}
              // An Enter still held from the address field must not answer the question it just moved to.
              onKeyDown={(e) => e.key === 'Enter' && e.repeat && e.preventDefault()}
              onClick={busy ? undefined : action.run}
            >
              {testingNow && action === testAction ? 'Testing…' : action.label}
              {action.external && <ExternalLink aria-hidden="true" />}
            </button>
            {keep && (
              <button className="btn" aria-describedby="settings-connection" onClick={keep.run}>
                {keep.label}
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  // A key that just failed its test can still be saved, but is no longer the suggested next step.
  // The field note follows the result on screen: a failure for an earlier model or provider no longer advises here
  // (the close prompt still remembers it).
  const draftFailed = unsavedKey && failedDrafts[provider] === keyEdits[provider] && !!test && !test.ok && test.draft && test.provider === provider;
  const keyField = status && (
    <StackedRow
      controlId={enteringKey ? 'settings-api-key' : undefined}
      groupId="settings-key"
      label={isLocal ? 'API key (optional)' : 'API key'}
      side={
        !isLocal && enteringKey && (keySaved || unsavedKey) ? (
          <button className="link-btn settings-row-link" title="Opens in your browser" onClick={() => void api.app.openExternal(keyUrl)}>
            Get {withArticle(status.label)} key <ExternalLink aria-hidden="true" />
          </button>
        ) : undefined
      }
      error={keyProblem}
      hint={
        // A failed test is not proof the key is wrong (the network or the model can fail too), so this is a note.
        draftFailed ? (
          <>
            <span className="settings-note-strong">{keyRejected(test.message) ? 'Paste a new key, then test it.' : 'Paste a corrected key, or test again if the problem was the connection.'}</span>
            {replacing[provider] && status.source === 'stored' && ' Saving replaces the key stored now, which can’t be recovered.'}
          </>
        ) : isLocal
          ? 'Only needed if your server asks for one.'
          : keyFromEnvironment && !enteringKey
            ? 'This development build is reading the key from your environment.'
            : replacing[provider] && status.source === 'stored'
              ? 'Saving replaces the key stored now, which can’t be recovered. Keep a copy if you may need it again.'
            : 'Stored on this computer, readable only by your user account. Never put in your projects, exports or logs.'
      }
    >
      {enteringKey ? (
        <div className="row">
          <input
            id="settings-api-key"
            aria-describedby="settings-api-key-note settings-connection"
            aria-invalid={keyProblem ? true : undefined}
            className="input grow mono"
            type={showKey ? 'text' : 'password'}
            spellCheck={false}
            autoComplete="off"
            placeholder={isLocal ? 'Paste a key' : provider === 'openai' ? 'Paste your key, starting sk-' : 'Paste your key, starting sk-ant-'}
            value={keys[provider]}
            onChange={(e) => {
              setKeys({ ...keys, [provider]: e.target.value });
              setKeyEdits((n) => ({ ...n, [provider]: n[provider] + 1 }));
              setKeyNotice(null);
            }}
            onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && keys[provider].trim() && !keyProblem && void saveKey()}
          />
          <button type="button" className="btn settings-key-reveal" aria-pressed={showKey} aria-label={showKey ? 'Hide key' : 'Show key'} title={showKey ? 'Hide key' : 'Show key'} onClick={() => setShowKey((v) => !v)}>
            {showKey ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </button>
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
          <button className={`btn${unsavedKey && !draftFailed && !keyProblem && !keyBusy && !(isLocal && (localBlocked || localServer?.phase === 'pending')) ? ' btn-primary' : ''}`} disabled={!unsavedKey || !!keyProblem} aria-disabled={keyBusy || undefined} onClick={() => void saveKey()}>
            {keyBusy ? 'Saving key…' : 'Save key'}
          </button>
        </div>
      ) : (
        <div className="settings-key-saved">
          <KeyRound aria-hidden="true" />
          <span className="grow">{keyFromEnvironment ? 'From your environment' : `${isLocal ? 'Server key' : `${label} key`} saved`}</span>
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
    </StackedRow>
  );

  // What choosing this provider means, said where it is chosen.
  const savedLocal = checkLocalBaseURL(settings.ai.local.baseURL, settings.ai.local.allowRemote);
  const localRemoteHost = savedLocal.ok && savedLocal.remote ? new URL(savedLocal.url).host : null;
  const providerNote = (
    <div className="settings-provider-note" id="settings-provider-note">
      <Shield aria-hidden="true" />
      <span>
        {!isLocal ? (
          `${provider === activeProvider ? 'Your request' : `With ${label} in use, your request`} and the relevant page text go to ${label}, which bills your account for usage. Images and screenshots are never sent.`
        ) : localRemoteHost ? (
          <>
            {provider === activeProvider ? 'When you use the assistant' : 'With Local model in use'}, your requests and page content go to <strong className="settings-host">{localRemoteHost}</strong>.
          </>
        ) : (
          provider === activeProvider ? 'Your requests and page content stay on this computer.' : 'With Local model in use, your requests and page content stay on this computer.'
        )}
      </span>
    </div>
  );

  const modelRow = (
    <StackedRow
      controlId="settings-model"
      label={custom ? 'Custom model ID' : 'Model'}
      side={
        (settings.developerMode || custom || !known) && (
          <button
            id="settings-model-mode"
            className="link-btn settings-row-link"
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
            {custom ? 'Choose from list' : 'Use another model ID'}
          </button>
        )
      }
      hint={custom ? 'Saved when you press Enter or leave the field.' : undefined}
    >
      {custom ? (
        <input
          id="settings-model"
          key={provider}
          className="input mono"
          value={modelDraft}
          onChange={(e) => setModelDrafts({ ...modelDrafts, [provider]: e.target.value })}
          // Moving to "Choose from list" leaves the typed ID unsaved, by pointer or by Tab.
          onBlur={(e) => e.relatedTarget?.id !== 'settings-model-mode' && commitModelDraft()}
          onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && commitModelDraft()}
          aria-describedby="settings-model-note"
          spellCheck={false}
        />
      ) : (
        <select id="settings-model" key={provider} className="select" value={model} onChange={(e) => void setModel(e.target.value)}>
          {!known && status && <option value={model}>{model} (custom)</option>}
          {status?.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
              {m.note ? ` — ${m.note}` : ''}
            </option>
          ))}
        </select>
      )}
    </StackedRow>
  );

  // Using the provider on screen is the next step only once its setup has passed a test; before that the card's own
  // next step is the page's one primary, so a server that isn't answering is never urged on chat.
  // A test that passed for a typed key is not the setup chat would use until that key is saved.
  const useReady = !unsavedKey && (isLocal ? !!localServer && connectionView(localServer).tone === 'ready' : connectionView().tone === 'ready');
  return (
    <Modal
      title="Settings"
      icon={<Settings />}
      onClose={close}
      footer={
        <>
          <span className="settings-foot-note">{unsavedProviders.length ? `${unsavedProviders.length > 1 ? 'Typed keys aren’t' : `Your ${nameOf(unsavedProviders[0])} key isn’t`} saved yet.` : 'Changes apply as you make them.'}</span>
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
              icon: <SlidersHorizontal aria-hidden="true" />,
              panel: () => (
                <>
                  <div className="settings-group">
                    <InlineRow id="settings-appearance" label="Appearance" hint="How SiteOrigin Builder looks. Your website’s colors are set in Site styles.">
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
                    </InlineRow>
                    <div className="settings-row">
                      <SwitchRow checked={settings.developerMode} onChange={(v) => void update({ developerMode: v })} label="Developer mode" hint="Shows code components and source views, for people comfortable editing Svelte. Code is checked before it’s saved." />
                    </div>
                  </div>
                  <div className="settings-group-title">Keyboard shortcuts</div>
                  <div className="settings-group">
                    <AskAiShortcut binding={settings.shortcuts.askAi} save={async (askAi) => void (await update({ shortcuts: { askAi } }))} />
                  </div>
                  <div className="settings-aside">
                    <History aria-hidden="true" />
                    <span>Each project keeps its last 100 changes, so Undo works even after you reopen it. This history stays on your computer and is never exported.</span>
                  </div>
                </>
              )
            },
            {
              value: 'ai',
              label: 'AI assistant',
              icon: <Sparkles aria-hidden="true" />,
              panel: () => (
                <>
                  <div className="settings-provider">
                    <div className="settings-group-title" id="settings-provider-label">
                      Provider
                    </div>
                    <Segmented<ProviderId>
                      radio
                      full
                      labelledBy="settings-provider-label"
                      describedBy="settings-provider-note"
                      value={provider}
                      onChange={(p) => {
                        setViewed(p);
                        setShowKey(false);
                      }}
                      options={providers.map((p) => ({ value: p.id, label: p.label, icon: p.id === 'local' ? <Laptop /> : <Cloud /> }))}
                    />
                    {providerNote}
                    {provider !== activeProvider && (
                      <div className="row">
                        <span className="grow">The assistant is using {providers.find((x) => x.id === activeProvider)?.label ?? activeProvider}.</span>
                        <button className={`btn${useReady ? ' btn-primary' : ''}`} onClick={() => void update({ ai: { provider } })}>
                          Use {label}
                        </button>
                      </div>
                    )}
                  </div>
                  {isLocal ? (
                    <LocalModelSettings settings={settings} update={update} keyRevision={keyRevision} keySaved={keySaved} revealKey={(keyNotice?.provider === 'local' && keyNotice.kind === 'failed') || !!keys.local.trim()} status={connection} keyField={keyField} onBlocked={setLocalBlocked} onStatus={setLocalServer} />
                  ) : (
                    <section className="settings-card" aria-label={`${label} connection`}>
                      {connection()}
                      {keyField}
                      {modelRow}
                    </section>
                  )}
                  <div className="settings-group-title">Chat</div>
                  <div className="settings-group">
                    <div className="settings-row">
                      <SwitchRow checked={settings.ai.sendOnEnter} onChange={(v) => void update({ ai: { sendOnEnter: v } })} label="Press Enter to send messages" hint={sendOnEnterHint(api.platform)} />
                    </div>
                  </div>
                </>
              )
            }
          ]}
        />
      </div>
    </Modal>
  );
}
