import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, RefreshCw, Shield, TriangleAlert } from 'lucide-react';
import type { AppSettings, SettingsPatch } from '@shared/api';
import { checkLocalBaseURL, LOCAL_PRESETS, type LocalToolMode } from '@shared/local';
import { api, setState } from '../store';
import { Field, SwitchRow } from '../components/ui';

/**
 * The server in use, for the connection status. `url` is the saved address (empty when it cannot be used),
 * which is the only one ever contacted, whatever is being typed. `revision` identifies the latest answer
 * from it, so a test result never outlives a newer check.
 */
export type LocalServerStatus = { url: string; remote: boolean; revision: number; refresh: () => Promise<number>; apply: () => void; revert: () => void; openKey: () => void } & (
  | { phase: 'invalid' | 'pending' | 'checking' | 'empty' }
  | { phase: 'unreachable'; reason: 'offline' | 'auth' | 'other'; message: string }
  | { phase: 'ready'; models: number; missing: boolean }
);

// Unique across this panel's mounts, so a result kept by the dialog can never match a later discovery.
let discoveries = 0;

const failureReason = (message: string) => (/rejected the API key/i.test(message) ? 'auth' : /^Could not connect|did not answer/i.test(message) ? 'offline' : 'other');

/** Where the local model is served, which model to use, and how it calls tools. */
export function LocalModelSettings({
  settings,
  update,
  keyRevision,
  keySaved,
  revealKey,
  status,
  keyField
}: {
  settings: AppSettings;
  update: (patch: SettingsPatch) => Promise<void>;
  keyRevision: number;
  keySaved: boolean;
  /** Opens the advanced options because the key field there needs attention. */
  revealKey: boolean;
  /** Renders the connection status for the server's current state. */
  status: (server: LocalServerStatus) => ReactNode;
  /** The optional server key, shown with the advanced options. */
  keyField: ReactNode;
}) {
  const local = settings.ai.local;
  const model = settings.ai.models.local;
  const [draft, setDraft] = useState(local.baseURL);
  const [models, setModels] = useState<string[]>([]);
  const [reach, setReach] = useState<{ ok: boolean; message?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  // Open when something in it is already in use, so a customized setting is never hidden.
  const [advanced, setAdvanced] = useState(local.toolMode !== 'auto' || keySaved);
  const request = useRef(0);
  const statusRequest = useRef(0);
  // Whether the field holds something the user typed, as opposed to the saved address.
  const edited = useRef(false);
  // The address most recently sent to be saved, which can be ahead of the settings on screen.
  const submitted = useRef(local.baseURL);

  const check = checkLocalBaseURL(draft, local.allowRemote);
  const offMachine = checkLocalBaseURL(draft, true);
  const isRemote = offMachine.ok && offMachine.remote;
  // The warning describes the server actually in use, whatever is being typed.
  const saved = checkLocalBaseURL(local.baseURL, local.allowRemote);
  const savedRemoteHost = saved.ok && saved.remote ? new URL(saved.url).host : null;
  const typedHost = offMachine.ok && offMachine.remote ? new URL(offMachine.url).host : savedRemoteHost;
  // The address is used as written once committed, so the field turns localhost into 127.0.0.1; this says why.
  const typedLocalhost = /^\s*https?:\/\/localhost(?::\d+)?(?:[/\s]|$)/i.test(draft);

  const refresh = useCallback(async () => {
    const id = ++discoveries;
    request.current = id;
    setLoading(true);
    // A failed request settles like any other answer, so the panel never stays on "Checking".
    const r = await api.ai.localModels().catch((e: unknown) => ({ ok: false, models: [] as string[], message: e instanceof Error ? e.message : 'Could not reach the server.' }));
    // A slower answer from the previous address must not replace this one.
    if (id !== request.current) return id;
    setLoading(false);
    setModels(r.models);
    setReach({ ok: r.ok, message: r.message ?? 'Could not reach the server.' });
    setRevision(id);
    return id;
  }, []);

  useEffect(() => {
    void refresh();
    const id = ++statusRequest.current;
    void api.ai.providers().then((providers) => {
      if (id === statusRequest.current) setState({ providers });
    });
  }, [local.baseURL, local.allowRemote, keyRevision, refresh]);

  useEffect(() => {
    if (!edited.current) setDraft(local.baseURL);
  }, [local.baseURL]);

  const authProblem = !!reach && !reach.ok && failureReason(reach.message ?? '') === 'auth';
  useEffect(() => {
    if (keySaved || revealKey || authProblem) setAdvanced(true);
  }, [keySaved, revealKey, authProblem]);

  // Half-typed addresses are never contacted: a URL is saved, and so used, only when it is committed.
  const commit = (value = draft) => {
    const next = checkLocalBaseURL(value, local.allowRemote);
    if (next.ok && next.url !== submitted.current) {
      submitted.current = next.url;
      void update({ ai: { local: { baseURL: next.url } } });
    }
    if (next.ok) {
      edited.current = false;
      setDraft(next.url);
    }
  };
  const pending = useRef({ draft, saved: local.baseURL, allowRemote: local.allowRemote });
  pending.current = { draft, saved: local.baseURL, allowRemote: local.allowRemote };
  // Closing Settings with Escape skips the field's blur.
  useEffect(
    () => () => {
      const p = pending.current;
      if (!edited.current) return;
      const next = checkLocalBaseURL(p.draft, p.allowRemote);
      if (!next.ok || next.url === submitted.current) return;
      submitted.current = next.url;
      // Chat shows the privacy note from the provider status, and this panel is gone once Settings closes.
      void update({ ai: { local: { baseURL: next.url } } }).then(() => api.ai.providers().then((providers) => setState({ providers })));
    },
    [update]
  );

  const choosePreset = (baseURL: string) => {
    edited.current = false;
    setDraft(baseURL);
    if (baseURL !== submitted.current) {
      submitted.current = baseURL;
      void update({ ai: { local: { baseURL } } });
    }
  };
  const allowRemote = (allow: boolean) => {
    const next = checkLocalBaseURL(draft, allow);
    if (allow && next.ok) {
      edited.current = false;
      submitted.current = next.url;
    }
    void update({ ai: { local: { allowRemote: allow, ...(allow && next.ok ? { baseURL: next.url } : {}) } } });
  };
  const missing = !!model && !models.includes(model);
  const url = saved.ok ? saved.url : '';
  // Results only ever describe the saved address, so a different one in the field holds them back.
  const revert = () => {
    edited.current = false;
    submitted.current = local.baseURL;
    setDraft(local.baseURL);
  };
  const openKey = () => {
    setAdvanced(true);
    requestAnimationFrame(() => (document.getElementById('settings-api-key') ?? document.getElementById('settings-key-replace'))?.focus());
  };
  const base = { url, remote: !!savedRemoteHost, revision, refresh, apply: () => commit(), revert, openKey };
  const server: LocalServerStatus = !check.ok
    ? { ...base, phase: 'invalid' }
    : check.url !== local.baseURL
      ? { ...base, phase: 'pending' }
      : loading || !reach
        ? { ...base, phase: 'checking' }
        : !reach.ok
          ? { ...base, phase: 'unreachable', reason: failureReason(reach.message ?? ''), message: reach.message ?? 'Could not reach the server.' }
          : !models.length
            ? { ...base, phase: 'empty' }
            : { ...base, phase: 'ready', models: models.length, missing };
  const settled = server.phase !== 'invalid' && server.phase !== 'pending';

  return (
    <>
      {status(server)}
      {savedRemoteHost && (
        <div className="scope-note danger" role="alert">
          <TriangleAlert />
          <span>
            Project content will leave this computer and go to <strong className="settings-host">{savedRemoteHost}</strong>. Only use a server you trust.
          </span>
        </div>
      )}
      <Field label="Server" controlId="settings-local-url" error={check.ok ? null : check.message} hint={typedLocalhost ? 'localhost is reached as 127.0.0.1. For a server that listens only on IPv6, use http://[::1]:port/v1.' : savedRemoteHost ? "Type your server's address and press Enter." : 'Start the server in your model app and load a model, then pick the app here or type the address it shows.'}>
        <div className="col" style={{ gap: 8 }}>
          <div className="row settings-presets" role="group" aria-label="Common server apps">
            {LOCAL_PRESETS.map((p) => (
              <button key={p.id} className="btn btn-sm" aria-current={local.baseURL === p.baseURL ? 'true' : undefined} onClick={() => choosePreset(p.baseURL)}>
                {p.label}
              </button>
            ))}
          </div>
          <input
            id="settings-local-url"
            aria-describedby="settings-local-url-note"
            aria-invalid={check.ok ? undefined : true}
            className="input mono"
            value={draft}
            spellCheck={false}
            onChange={(e) => {
              edited.current = true;
              setDraft(e.target.value);
            }}
            onBlur={() => commit()}
            onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && commit()}
          />
        </div>
      </Field>
      {(isRemote || local.allowRemote) && (
        <SwitchRow
          checked={local.allowRemote}
          onChange={allowRemote}
          label="Allow a server on another machine"
          hint={local.allowRemote ? (savedRemoteHost ? 'Turn this off to allow only servers on this computer.' : 'Allowed, but the server in use is on this computer.') : <>Turning this on sends your requests and page content to <span className="settings-host">{typedHost ?? 'that server'}</span>.</>}
        />
      )}
      <Field label="Model" controlId="settings-local-model">
        <div className="row">
          <select id="settings-local-model" className="select grow" disabled={!settled || (!models.length && !missing)} value={model} onChange={(e) => void update({ ai: { models: { ...settings.ai.models, local: e.target.value } } })}>
            <option value="">{settled && reach?.ok && !models.length ? 'No models on this server' : "Use the server's model"}</option>
            {missing && (
              <option value={model}>
                {model}
                {reach?.ok ? ' (not on this server)' : ''}
              </option>
            )}
            {models.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          {/* Only with a list to refresh: otherwise the status above already offers the retry. */}
          {models.length > 0 && (
            <button
              className="btn"
              disabled={!settled}
              aria-disabled={loading || undefined}
              onClick={async () => {
                if (loading) return;
                await refresh();
                // The list can come back empty and take this button with it.
                requestAnimationFrame(() => {
                  if (document.activeElement === document.body) document.querySelector<HTMLElement>('.settings-status button')?.focus();
                });
              }}
            >
              <RefreshCw /> {loading ? 'Checking…' : 'Refresh'}
            </button>
          )}
        </div>
      </Field>
      <details className="settings-advanced" open={advanced} onToggle={(e) => setAdvanced(e.currentTarget.open)}>
        <summary>
          <ChevronRight aria-hidden="true" /> Advanced server options
        </summary>
        <div className="settings-advanced-body">
          <Field label="Tool calling" hint="How the assistant asks your model to make edits. Automatic suits most models.">
            <select className="select" value={local.toolMode} onChange={(e) => void update({ ai: { local: { toolMode: e.target.value as LocalToolMode } } })}>
              <option value="auto">Automatic</option>
              <option value="constrained-json">Constrained JSON</option>
              <option value="native">Native tool calls</option>
            </select>
          </Field>
          {keyField}
        </div>
      </details>
      {!savedRemoteHost && (
        <div className="scope-note info">
          <Shield />
          <span>Your requests and page content stay on this computer.</span>
        </div>
      )}
    </>
  );
}
