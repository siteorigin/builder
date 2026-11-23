import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import type { AppSettings, SettingsPatch } from '@shared/api';
import { checkLocalBaseURL, LOCAL_PRESETS, type LocalToolMode } from '@shared/local';
import { api, setState } from '../store';
import { Field, SwitchRow } from '../components/ui';

/** Where the local model is served, which model to use, and how it calls tools. */
export function LocalModelSettings({ settings, update, keyRevision }: { settings: AppSettings; update: (patch: SettingsPatch) => Promise<void>; keyRevision: number }) {
  const local = settings.ai.local;
  const model = settings.ai.models.local;
  const [draft, setDraft] = useState(local.baseURL);
  const [models, setModels] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
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

  const refresh = useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    const r = await api.ai.localModels();
    // A slower answer from the previous address must not replace this one.
    if (id !== request.current) return;
    setLoading(false);
    setModels(r.models);
    setProblem(r.ok ? (r.models.length ? null : 'The server has no models loaded.') : (r.message ?? 'Could not reach the server.'));
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
  const options = model && !models.includes(model) ? [model, ...models] : models;

  return (
    <>
      <Field label="Server" controlId="settings-local-url" error={check.ok ? null : check.message} hint={savedRemoteHost ? 'The address of your model server.' : 'The address of a model server running on this computer.'}>
        <div className="col" style={{ gap: 8 }}>
          <div className="row" role="group" aria-label="Server presets" style={{ flexWrap: 'wrap', gap: 6 }}>
            {LOCAL_PRESETS.map((p) => (
              <button key={p.id} className={`btn btn-sm${local.baseURL === p.baseURL ? ' active' : ''}`} aria-pressed={local.baseURL === p.baseURL} onClick={() => choosePreset(p.baseURL)}>
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
        <>
          <SwitchRow checked={local.allowRemote} onChange={allowRemote} label="Allow a server on another machine" hint="Your requests and page content are sent to that server." />
        </>
      )}
      {savedRemoteHost && (
        <div className="scope-note danger" role="alert">
          <TriangleAlert />
          <span>Project content will leave this computer and go to {savedRemoteHost}. Only use a server you trust.</span>
        </div>
      )}
      <Field label="Model" controlId="settings-local-model" error={problem}>
        <div className="row">
          <select id="settings-local-model" aria-describedby="settings-local-model-note" className="select grow" value={model} onChange={(e) => void update({ ai: { models: { ...settings.ai.models, local: e.target.value } } })}>
            <option value="">Use the server's model</option>
            {options.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <button className="btn" disabled={loading} onClick={() => void refresh()}>
            <RefreshCw /> {loading ? 'Checking…' : 'Refresh'}
          </button>
        </div>
      </Field>
      <Field label="Tool calling" hint="Automatic uses constrained JSON unless the model is known to handle native tools well.">
        <select className="select" value={local.toolMode} onChange={(e) => void update({ ai: { local: { toolMode: e.target.value as LocalToolMode } } })}>
          <option value="auto">Automatic</option>
          <option value="constrained-json">Constrained JSON</option>
          <option value="native">Native tool calls</option>
        </select>
      </Field>
    </>
  );
}
