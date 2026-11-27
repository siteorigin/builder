import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { RefreshCw, TriangleAlert } from 'lucide-react';
import type { AppSettings, SettingsPatch } from '@shared/api';
import { checkLocalBaseURL, LOCAL_CONTEXT_MAX, LOCAL_CONTEXT_MIN, LOCAL_PRESETS, localServerKey, parseContextSize, type LocalToolMode } from '@shared/local';
import { api, refreshProviders } from '../store';
import { Disclosure, SwitchRow } from '../components/ui';

/**
 * The server in use, for the connection status. `url` is the saved address (empty when it cannot be used),
 * which is the only one ever contacted, whatever is being typed. `revision` identifies the latest answer
 * from it, so a test result never outlives a newer check.
 */
export type LocalServerStatus = { url: string; remote: boolean; proposedHost?: string; revision: number; refresh: () => Promise<number>; apply: () => void; revert: () => void; openKey: () => void } & (
  | { phase: 'pending' | 'checking' | 'empty' }
  // `remoteHost`: the address is fine but on another machine, which is not allowed yet.
  | { phase: 'invalid'; remoteHost?: string }
  // `firstRun`: nothing has answered yet at an untouched default address, the usual first visit, not a fault.
  | { phase: 'unreachable'; reason: 'offline' | 'auth' | 'other'; message: string; firstRun: boolean }
  | { phase: 'ready'; models: number; missing: boolean }
);

// Unique across this panel's mounts, so a result kept by the dialog can never match a later discovery.
let discoveries = 0;

/**
 * One row of a settings group with its label and note on the left and a compact control on the right. The
 * label is `${id}-label` (a real label when `controlId` names the control) and the note `${id}-note`, which an
 * error replaces.
 */
export function InlineRow({ id, controlId, label, hint, error, children }: { id: string; controlId?: string; label: string; hint?: ReactNode; error?: string | null; children: ReactNode }) {
  return (
    <div className="settings-row settings-row-inline">
      <div className="settings-row-text">
        {controlId ? (
          <label className="settings-row-label" id={`${id}-label`} htmlFor={controlId}>
            {label}
          </label>
        ) : (
          <div className="settings-row-label" id={`${id}-label`}>
            {label}
          </div>
        )}
        {error ? (
          <div className="field-error" id={`${id}-note`}>
            {error}
          </div>
        ) : (
          hint && (
            <div className="field-hint" id={`${id}-note`}>
              {hint}
            </div>
          )
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * A row whose control takes the full width under its label: a key, an address, a model. `side` sits at the
 * end of the label line, outside the label so it never becomes part of the control's name. With no
 * `controlId` (a saved key has no field) the label names the row as a group instead. The note is
 * `${controlId}-note`; an error takes the note's place.
 */
export function StackedRow({
  controlId,
  groupId,
  label,
  side,
  hint,
  error,
  children
}: {
  controlId?: string;
  groupId?: string;
  label: ReactNode;
  side?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
}) {
  const noteId = `${controlId ?? groupId}-note`;
  const note = error ? (
    <div className="field-error" id={noteId}>
      {error}
    </div>
  ) : hint ? (
    <div className="field-hint" id={noteId}>
      {hint}
    </div>
  ) : null;
  return (
    <div className="settings-row">
      <div className="settings-row-head">
        {controlId ? (
          <label className="settings-row-label" htmlFor={controlId}>
            {label}
          </label>
        ) : (
          <div className="settings-row-label" id={`${groupId}-label`}>
            {label}
          </div>
        )}
        {side}
      </div>
      {controlId ? (
        children
      ) : (
        <div role="group" aria-labelledby={`${groupId}-label`} aria-describedby={note ? noteId : undefined}>
          {children}
        </div>
      )}
      {note}
    </div>
  );
}

const failureReason = (message: string) => (/rejected the API key/i.test(message) ? 'auth' : /^Could not connect|did not answer/i.test(message) ? 'offline' : 'other');

/** Where the local model is served, which model to use, and how it calls tools. */
export function LocalModelSettings({
  settings,
  update,
  keyRevision,
  keySaved,
  revealKey,
  status,
  keyField,
  onBlocked,
  onStatus
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
  /** Told whether the server is unreachable or has nothing loaded, which a typed key cannot fix. */
  onBlocked?: (blocked: boolean) => void;
  /** Told the server's state as the status shows it, so the dialog can say what it means for the rest of the page. */
  onStatus?: (server: LocalServerStatus | null) => void;
}) {
  const local = settings.ai.local;
  const model = settings.ai.models.local;
  const [draft, setDraft] = useState(local.baseURL);
  const [models, setModels] = useState<string[]>([]);
  // The server the model list came from: a list is only ever shown, or chosen from, for that server.
  const [listedFor, setListedFor] = useState<string | null>(null);
  const [reach, setReach] = useState<{ ok: boolean; message?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  // Open when something in it is already in use, so a customized setting is never hidden.
  const [advanced, setAdvanced] = useState(local.toolMode !== 'auto' || keySaved || local.contextWindow !== null);
  const request = useRef(0);
  // Whether any server has answered while this panel was open, or the user has asked for a check: after either,
  // a failure is a failure, never a first visit.
  const answered = useRef(false);
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

  // The address a discovery asked, so an answer is only ever shown for the address it describes.
  const asking = useRef(local.baseURL);
  asking.current = local.baseURL;
  const [reachedFor, setReachedFor] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const forURL = asking.current;
    const id = ++discoveries;
    request.current = id;
    setLoading(true);
    // A failed request settles like any other answer, so the panel never stays on "Checking".
    const r = await api.ai.localModels().catch((e: unknown) => ({ ok: false, models: [] as string[], message: e instanceof Error ? e.message : 'Could not reach the server.', server: undefined }));
    // A slower answer from the previous address must not replace this one.
    if (id !== request.current) return id;
    setLoading(false);
    setModels(r.models);
    // The main process says which saved server it asked, which may be newer than the settings on screen.
    setListedFor(r.server ? localServerKey(r.server) : null);
    setReach({ ok: r.ok, message: r.message ?? 'Could not reach the server.' });
    setReachedFor(forURL);
    if (r.ok) answered.current = true;
    setRevision(id);
    // The provider status carries what the list showed, so Chat knows a server is down.
    void refreshProviders();
    return id;
  }, []);

  useEffect(() => {
    void refresh();
  }, [local.baseURL, local.allowRemote, keyRevision, refresh]);

  useEffect(() => {
    if (!edited.current) setDraft(local.baseURL);
  }, [local.baseURL]);

  const authProblem = !!reach && !reach.ok && failureReason(reach.message ?? '') === 'auth';
  useEffect(() => {
    if (keySaved || revealKey || authProblem) setAdvanced(true);
  }, [keySaved, revealKey, authProblem]);

  // Another machine that is not the one in use now: leaving the field or closing Settings never sends content
  // there, and Enter only takes the keyboard to the question; Use this address is the one way to it.
  const newRemoteHost = (next: ReturnType<typeof checkLocalBaseURL>, current = savedRemoteHost) => (next.ok && next.remote && new URL(next.url).host !== current ? new URL(next.url).host : null);
  // Half-typed addresses are never contacted: a URL is saved, and so used, only when it is committed.
  const commit = (value = draft, explicit = true) => {
    const next = checkLocalBaseURL(value, local.allowRemote);
    if (!explicit && newRemoteHost(next)) return;
    if (next.ok && next.url !== submitted.current) {
      submitted.current = next.url;
      void update({ ai: { local: { baseURL: next.url } } });
    }
    if (next.ok) {
      edited.current = false;
      setDraft(next.url);
    }
  };
  // The latest of each, for the unmount below: comparing with what was saved when the panel opened could let a
  // close switch back to a machine the user has since moved away from.
  const pending = useRef({ draft, saved: local.baseURL, allowRemote: local.allowRemote, remoteHost: savedRemoteHost });
  pending.current = { draft, saved: local.baseURL, allowRemote: local.allowRemote, remoteHost: savedRemoteHost };
  // Closing Settings with Escape skips the field's blur.
  useEffect(
    () => () => {
      const p = pending.current;
      if (!edited.current) return;
      const next = checkLocalBaseURL(p.draft, p.allowRemote);
      if (!next.ok || next.url === submitted.current || newRemoteHost(next, p.remoteHost)) return;
      submitted.current = next.url;
      // Chat shows the privacy note from the provider status, and this panel is gone once Settings closes.
      void update({ ai: { local: { baseURL: next.url } } }).then(() => refreshProviders());
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
  const [justAllowed, setJustAllowed] = useState(false);
  const allowRemote = (allow: boolean) => {
    setJustAllowed(allow);
    const next = checkLocalBaseURL(draft, allow);
    if (allow && next.ok) {
      edited.current = false;
      submitted.current = next.url;
    }
    void update({ ai: { local: { allowRemote: allow, ...(allow && next.ok ? { baseURL: next.url } : {}) } } });
  };
  // A list from another server (the one before a switch, while this one is still being asked) is never offered:
  // until the main process says it asked the saved server, the list is still being checked.
  const current = !loading && !!listedFor && listedFor === localServerKey(local.baseURL);
  const missing = !!model && !models.includes(model);
  const shownWindow = local.contextWindow === null ? '' : String(local.contextWindow);
  const [windowDraft, setWindowDraft] = useState(shownWindow);
  // As for the address: whether the field holds the author's typing, and the size most recently sent to be saved.
  const windowEdited = useRef(false);
  const windowSubmitted = useRef(local.contextWindow);
  // A saved size arriving (also one sent before this panel opened) is what a later change is compared with.
  useEffect(() => {
    windowSubmitted.current = local.contextWindow;
    if (!windowEdited.current) setWindowDraft(shownWindow);
  }, [local.contextWindow, shownWindow]);
  const windowCheck = parseContextSize(windowDraft);
  const windowError = windowCheck.ok ? null : `Enter a whole number of tokens from ${LOCAL_CONTEXT_MIN.toLocaleString('en-US')} to ${LOCAL_CONTEXT_MAX.toLocaleString('en-US')}, or leave it empty.`;
  // Only a valid size is saved; an empty field goes back to reading the size from the server.
  const commitWindow = () => {
    if (!windowCheck.ok) return;
    windowEdited.current = false;
    if (windowCheck.value === windowSubmitted.current) return;
    windowSubmitted.current = windowCheck.value;
    void update({ ai: { local: { contextWindow: windowCheck.value } } });
  };
  const pendingWindow = useRef(windowDraft);
  pendingWindow.current = windowDraft;
  // Closing Settings with Escape skips the field's blur, as for the address.
  useEffect(
    () => () => {
      if (!windowEdited.current) return;
      const next = parseContextSize(pendingWindow.current);
      if (next.ok && next.value !== windowSubmitted.current) void update({ ai: { local: { contextWindow: next.value } } });
    },
    [update]
  );
  const url = saved.ok ? saved.url : '';
  // The choice is kept for the server whose models are listed, and each server keeps its own.
  const chooseModel = (id: string) => {
    if (current && listedFor) void update({ ai: { local: { modelsByServer: { [listedFor]: id } } } });
  };
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
  // Nothing chosen yet: the address is still one of the defaults, no model is picked, and nothing has answered.
  const firstRun = !answered.current && !model && !savedRemoteHost && LOCAL_PRESETS.some((p) => p.baseURL === local.baseURL);
  const customized = local.toolMode !== 'auto' || local.contextWindow !== null || keySaved;
  const userRefresh = () => {
    answered.current = true;
    return refresh();
  };
  const proposedHost = check.ok && check.url !== local.baseURL ? newRemoteHost(check) : null;
  const base = { url, remote: !!savedRemoteHost, proposedHost: proposedHost ?? undefined, revision, refresh: userRefresh, apply: () => commit(), revert, openKey };
  // A whole address on another machine is not a mistake in the field: the switch below is what it waits for.
  const blockedRemoteHost = !check.ok && isRemote && !local.allowRemote && offMachine.ok ? new URL(offMachine.url).host : null;
  const server: LocalServerStatus = !check.ok
    ? { ...base, phase: 'invalid', remoteHost: blockedRemoteHost ?? undefined }
    : check.url !== local.baseURL
      ? { ...base, phase: 'pending' }
      : loading || !reach || reachedFor !== local.baseURL || (reach.ok && !current)
        ? { ...base, phase: 'checking' }
        : !reach.ok
          ? { ...base, phase: 'unreachable', reason: failureReason(reach.message ?? ''), message: reach.message ?? 'Could not reach the server.', firstRun }
          : !models.length
            ? { ...base, phase: 'empty' }
            : { ...base, phase: 'ready', models: models.length, missing };
  const settled = server.phase !== 'invalid' && server.phase !== 'pending';
  const blocked = server.phase === 'empty' || (server.phase === 'unreachable' && server.reason !== 'auth');
  useEffect(() => {
    onBlocked?.(blocked);
  }, [blocked, onBlocked]);
  useEffect(() => () => onBlocked?.(false), [onBlocked]);
  const latest = useRef(server);
  latest.current = server;
  const missingNow = server.phase === 'ready' && server.missing;
  useEffect(() => {
    onStatus?.(latest.current);
  }, [onStatus, server.phase, server.url, server.revision, missingNow, server.proposedHost]);
  useEffect(() => () => onStatus?.(null), [onStatus]);
  const ready = server.phase === 'ready';
  // The options are models and nothing else: what the server is doing is the status's job, and why the list is
  // unavailable is the row's note. No choice means the first model the server lists, which is named when known.
  const automatic = ready && models.length ? `Automatic (${models[0]})` : 'Automatic';
  const showSaved = !!model && (!ready || missing);
  const modelNote = ready
    ? null
    : !settled
      ? 'Models are listed once the address above is in use.'
      : server.phase === 'empty'
        ? 'No models to choose from yet.'
        : server.phase === 'unreachable' && server.reason === 'auth'
          ? 'Add or update the server key to list its models.'
        : 'The server’s models are listed here once it answers.';
  const modelError = ready && missing ? 'Not on this server. Choose one of its models.' : null;
  // One note for the address in every state: how a typed one takes effect. Choosing another machine is confirmed in
  // the status above, and allowing one in the switch below.
  const addressHint = 'Applies on Enter or when you leave the field. Another machine needs your OK first.';
  // The field's own address, as the app presets compare: a preset is pressed only while the field holds its address.
  const fieldURL = offMachine.ok ? offMachine.url : null;
  const active = settings.ai.provider === 'local';
  // Named rather than flagged: what in the closed options differs from its default.
  const customizedParts = [
    local.toolMode === 'constrained-json' ? 'Constrained JSON' : local.toolMode === 'native' ? 'Native tool calls' : null,
    local.contextWindow !== null ? `${local.contextWindow.toLocaleString('en-US')} tokens` : null,
    keySaved ? 'Server key' : null
  ].filter(Boolean);

  return (
    <section className="settings-card" aria-label="Local model connection">
      {status(server)}
      <StackedRow
        controlId="settings-local-url"
        label="Server address"
        side={
          <div className="settings-presets">
            <span className="settings-presets-lead" id="settings-presets-label">
              Usual address for
            </span>
            <div className="settings-presets-track" role="group" aria-labelledby="settings-presets-label">
            {LOCAL_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={fieldURL === p.baseURL}
                aria-description={p.baseURL}
                title={p.baseURL}
                // Keeps a half-typed address from being applied by the blur on the way to the preset.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choosePreset(p.baseURL)}
              >
                {p.label}
              </button>
            ))}
            </div>
          </div>
        }
        error={check.ok || blockedRemoteHost ? null : check.message}
        hint={addressHint}
      >
        <div className="row">
          <input
            id="settings-local-url"
            aria-describedby="settings-local-url-note"
            aria-invalid={check.ok || blockedRemoteHost ? undefined : true}
            className="input grow mono"
            value={draft}
            spellCheck={false}
            onChange={(e) => {
              edited.current = true;
              setDraft(e.target.value);
            }}
            // Moving to the presets is still choosing an address, so it commits nothing on the way.
            onBlur={(e) => !(e.relatedTarget instanceof HTMLElement && e.relatedTarget.closest('.settings-presets')) && commit(draft, false)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              // A new machine is a question, not an edit: Enter takes the keyboard to its answer instead of answering it.
              if (e.key === 'Enter') {
                if (proposedHost) {
                  // Consumed here, so the press that moves focus can't also confirm on the button it lands on.
                  e.preventDefault();
                  document.getElementById('settings-status-action')?.focus();
                } else commit();
              }
              // A switch to another machine waiting to be confirmed: Escape backs out of it rather than closing.
              else if (e.key === 'Escape' && proposedHost) {
                e.preventDefault();
                e.stopPropagation();
                revert();
              }
            }}
          />
        </div>
      </StackedRow>
      {(isRemote || local.allowRemote) && (
        <div className="settings-row">
          <SwitchRow
            checked={local.allowRemote}
            onChange={allowRemote}
            label="Allow a server on another machine"
            hint={local.allowRemote ? (savedRemoteHost ? 'Turn this off to allow only servers on this computer.' : 'Allowed, but the server in use is on this computer.') : <>Turning this on makes <span className="settings-host">{typedHost ?? 'that server'}</span> the Local model server. Your requests and page content go there{active ? '' : ' once Local model is in use'}.</>}
          />
          {savedRemoteHost && (
            // Assertive only when it appears because the user just allowed it, not every time Settings opens.
            <div className="scope-note danger settings-remote-warning" role={justAllowed ? 'alert' : undefined}>
              <TriangleAlert />
              <span>
                {active ? 'When you use the assistant, project content' : 'With Local model in use, project content'} leaves this computer for <strong className="settings-host">{savedRemoteHost}</strong>. Only use a server you trust.
              </span>
            </div>
          )}
        </div>
      )}
      <StackedRow controlId="settings-local-model" label="Model" hint={modelNote} error={modelError}>
        <div className="row">
          <select
            id="settings-local-model"
            className="select grow"
            disabled={!ready}
            aria-invalid={modelError ? true : undefined}
            aria-describedby={modelNote || modelError ? 'settings-local-model-note' : undefined}
            value={ready || showSaved ? model : ''}
            onChange={(e) => chooseModel(e.target.value)}
          >
            <option value="">{automatic}</option>
            {/* Shown so the field says what is saved, but not offered again: it is not one the server can use. */}
            {showSaved && (
              <option value={model} disabled={ready}>
                {model}
              </option>
            )}
            {ready &&
              models.map((id) => (
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
      </StackedRow>
      <Disclosure
        row
        className="settings-advanced"
        open={advanced}
        onToggle={(e) => setAdvanced(e.currentTarget.open)}
        summary={
          <>
            Advanced server options
            {!advanced && customized && <span className="settings-advanced-flag">{customizedParts.join(' · ')}</span>}
          </>
        }
      >
        <div className="settings-advanced-body">
          <InlineRow id="settings-local-tools" controlId="settings-local-tools-select" label="Tool calling" hint="How the assistant asks your model to make edits. Automatic suits most models.">
            <select id="settings-local-tools-select" className="select settings-inline-control" aria-describedby="settings-local-tools-note" value={local.toolMode} onChange={(e) => void update({ ai: { local: { toolMode: e.target.value as LocalToolMode } } })}>
              <option value="auto">Automatic</option>
              <option value="constrained-json">Constrained JSON</option>
              <option value="native">Native tool calls</option>
            </select>
          </InlineRow>
          <InlineRow id="settings-local-context" controlId="settings-local-context" label="Context size" error={windowError} hint="Tokens your model is loaded with. Leave empty to use what the server reports. This doesn’t change the server.">
            <input
              id="settings-local-context"
              aria-describedby="settings-local-context-note"
              aria-invalid={windowError ? true : undefined}
              className="input settings-inline-control"
              inputMode="numeric"
              placeholder="From the server"
              value={windowDraft}
              spellCheck={false}
              onChange={(e) => {
                windowEdited.current = true;
                setWindowDraft(e.target.value);
              }}
              onBlur={commitWindow}
              onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && commitWindow()}
            />
          </InlineRow>
          {keyField}
        </div>
      </Disclosure>
    </section>
  );
}
