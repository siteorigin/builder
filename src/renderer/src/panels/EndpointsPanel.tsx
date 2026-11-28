/**
 * The project's own API endpoints, in Site settings with Developer mode on (#1481): its `+server.js` and `+server.ts`
 * files listed by route, made under /api/, edited and saved, and sent test requests against the running preview,
 * with the status, time taken and answer (JSON laid out) shown; and the environment variables they read, declared by
 * name with a value kept on this computer only. Values are typed here and never shown again: the main process keeps
 * them in the project's .env, which no export or saved version carries (main/project/endpoint-env.ts).
 */
import './EndpointsPanel.css';
import { useEffect, useRef, useState } from 'react';
import { ENDPOINT_METHODS, newEndpointProblem, newEndpointRoute, parseHeaderLines, shownBody, type EndpointFile, type EndpointLanguage, type EndpointMethod, type EndpointResponse } from '@shared/endpoints';
import { envNameProblem, envValueProblem, type EndpointEnvironment } from '@shared/endpoint-env';
import { runsOnNode } from '@shared/deploy-target';
import { api, confirmDialog, useStore } from '../store';
import { CodeEditor } from '../components/CodeEditor';
import { Field, openSection } from '../components/ui';

/** An endpoint open in the editor: the text as saved (`saved`, `hash`) and as edited (`text`). */
interface Open {
  file: string;
  language: EndpointLanguage;
  saved: string;
  text: string;
  hash: string;
}

/** A route as a first address to test: its parameters (`[id]`, `[...rest]`) left for the author to fill in. */
const testPath = (route: string) => route;

export function EndpointsPanel() {
  const opening = useStore((s) => s.snapshot?.workspaceKey ?? '');
  const readOnly = useStore((s) => !!s.snapshot?.readOnly);
  const node = useStore((s) => (s.snapshot ? runsOnNode(s.snapshot.state.site) : false));
  const previewReady = useStore((s) => s.runtime.state === 'ready');
  const [endpoints, setEndpoints] = useState<EndpointFile[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: 'error' | 'info' } | null>(null);
  const [saving, setSaving] = useState(false);
  const [newRoute, setNewRoute] = useState('');
  const [newLanguage, setNewLanguage] = useState<EndpointLanguage>('ts');
  const [newError, setNewError] = useState<string | null>(null);
  // Anything answered for an earlier opening is dropped, and so is a file read the author has since moved on from.
  const current = useRef(opening);
  current.current = opening;
  const reading = useRef(0);
  const failed = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const refresh = async () => {
    const at = opening;
    const r = await api.project.listEndpoints(at).catch((e: unknown) => ({ ok: false as const, message: failed(e) }));
    if (current.current !== at) return;
    if (r.ok) {
      setEndpoints(r.endpoints);
      setListError(null);
    } else setListError(r.message);
  };
  /** Whether unsaved changes may go, asking first when there are some. */
  const mayLeave = async () => !open || open.text === open.saved || (await confirmDialog({ title: 'Discard your changes?', body: `Your changes to ${open.file} have not been saved.`, subject: open.file, confirmLabel: 'Discard changes', stayLabel: 'Keep editing', tone: 'caution' })) === true;
  useEffect(() => {
    void refresh();
  }, [opening]); // eslint-disable-line react-hooks/exhaustive-deps

  const openFile = async (ep: EndpointFile) => {
    if (!(await mayLeave())) return;
    const at = opening;
    const asked = ++reading.current;
    const r = await api.project.readEndpoint(ep.file, at).catch((e: unknown) => ({ ok: false as const, message: failed(e) }));
    if (current.current !== at || reading.current !== asked) return;
    if (!r.ok) return setMessage({ text: r.message, tone: 'error' });
    setOpen({ file: ep.file, language: ep.language, saved: r.text, text: r.text, hash: r.hash });
    setMessage(null);
  };

  const save = async () => {
    if (!open || saving) return;
    setSaving(true);
    const at = opening;
    const draft = open;
    const r = await api.project
      .saveEndpoint(draft.file, draft.text, draft.hash, at)
      .catch((e: unknown) => ({ ok: false as const, message: failed(e) }))
      .finally(() => setSaving(false));
    if (current.current !== at) return;
    if (!r.ok) return setMessage({ text: r.message, tone: 'error' });
    // What was typed while it saved stays unsaved.
    setOpen((o) => (o && o.file === draft.file ? { ...o, saved: draft.text, hash: r.hash } : o));
    setMessage({ text: `Saved ${open.file}. The preview runs the new code at once.`, tone: 'info' });
    void refresh();
  };

  const create = async () => {
    const route = newEndpointRoute(newRoute);
    if (!route) return setNewError(newEndpointProblem(newRoute.startsWith('/api/') ? newRoute : `/api/${newRoute.replace(/^\/+/, '')}`) ?? 'Enter an address, such as /api/search.');
    if (!(await mayLeave())) return;
    const at = opening;
    ++reading.current;
    const r = await api.project.createEndpoint(route, newLanguage, at).catch((e: unknown) => ({ ok: false as const, message: failed(e) }));
    if (current.current !== at) return;
    if (!r.ok) return setNewError(r.message);
    setNewRoute('');
    setNewError(null);
    setOpen({ file: r.endpoint.file, language: r.endpoint.language, saved: r.text ?? '', text: r.text ?? '', hash: r.hash });
    setMessage({ text: `Made ${r.endpoint.file}.`, tone: 'info' });
    void refresh();
  };

  const dirty = !!open && open.text !== open.saved;
  const shown = endpoints ?? [];
  const selected = open ? shown.find((e) => e.file === open.file) : undefined;
  return (
    <div className="ep-panel">
      <p className="ep-intro">
        Your site’s own API endpoints: <code>+server.js</code> and <code>+server.ts</code> files in <code>src/routes</code>. They run on the server, in the preview as you edit and on the
        published site.
      </p>
      {!node && shown.length > 0 && (
        <p className="ep-note" role="note">
          This site is exported as a static website, which can’t run endpoints.{' '}
          <button type="button" className="link-btn" onClick={() => openSection('site-deployment')}>
            Choose Node.js server
          </button>{' '}
          under Deployment to export them, or add <code>export const prerender = true</code> to one that answers the same every time.
        </p>
      )}
      {listError ? (
        <p className="ep-error" role="alert">
          {listError}
        </p>
      ) : endpoints === null ? (
        <p className="faint">Looking for endpoints…</p>
      ) : shown.length === 0 ? (
        <p className="faint">This project has no endpoints yet.</p>
      ) : (
        <ul className="ep-list" aria-label="Endpoints">
          {shown.map((ep) => (
            <li key={ep.file}>
              <button type="button" className={`ep-item${open?.file === ep.file ? ' is-open' : ''}`} aria-current={open?.file === ep.file || undefined} onClick={() => void openFile(ep)}>
                <span className="ep-route">{ep.route}</span>
                <span className="ep-methods">{ep.methods.length ? ep.methods.join(' ') : 'no handlers found'}</span>
                <span className="ep-file faint">{ep.file}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <form
          className="ep-new"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <Field label="New endpoint" error={newError ?? undefined}>
            <input id="ep-new-route" className="input" value={newRoute} placeholder="/api/search" spellCheck={false} onChange={(e) => (setNewError(null), setNewRoute(e.target.value))} />
          </Field>
          <div className="ep-new-row">
            <select className="select" aria-label="Language" value={newLanguage} onChange={(e) => setNewLanguage(e.target.value as EndpointLanguage)}>
              <option value="ts">TypeScript</option>
              <option value="js">JavaScript</option>
            </select>
            <button type="submit" className="btn btn-sm">
              Add endpoint
            </button>
          </div>
        </form>
      )}
      {open && (
        <div className="ep-editor">
          <div className="ep-editor-head">
            <code className="ep-editor-file">{open.file}</code>
            {!readOnly && (
              <button type="button" className="btn btn-sm btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
                {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
              </button>
            )}
          </div>
          <CodeEditor key={open.file} value={open.text} language={open.language} label={`${open.file} source`} height="320px" readOnly={readOnly} locked={saving} onChange={(text) => setOpen((o) => (o ? { ...o, text } : o))} onSave={() => void save()} saveHint={dirty ? 'saves' : null} />
        </div>
      )}
      {message && (
        <p className={message.tone === 'error' ? 'ep-error' : 'ep-saved faint'} role={message.tone === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
      <EndpointTester key={opening} opening={opening} route={selected?.route ?? shown[0]?.route ?? '/api/'} methods={selected?.methods ?? []} previewReady={previewReady} />
      <EndpointVariables key={`env-${opening}`} opening={opening} readOnly={readOnly} />
    </div>
  );
}

/** Send a request to the preview and show what came back. */
function EndpointTester({ opening, route, methods, previewReady }: { opening: string; route: string; methods: string[]; previewReady: boolean }) {
  const [method, setMethod] = useState<EndpointMethod>('GET');
  const [path, setPath] = useState(testPath(route));
  const [headers, setHeaders] = useState('content-type: application/json');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [answer, setAnswer] = useState<EndpointResponse | null>(null);
  const current = useRef(opening);
  current.current = opening;
  // Each request's number: an answer to one sent before another endpoint was chosen, or another request, is dropped.
  const sent = useRef(0);
  // Another endpoint chosen: its route is what is tested next.
  useEffect(() => {
    // A request still under way is for the endpoint left behind: it is called off.
    if (sent.current) void api.project.stopEndpointRequest().catch(() => undefined);
    sent.current++;
    setPath(testPath(route));
    setAnswer(null);
    setSending(false);
  }, [route]);
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const send = async () => {
    setSending(true);
    setAnswer(null);
    const at = opening;
    const asked = ++sent.current;
    const r = await api.project
      .sendEndpointRequest({ method, path: path.trim(), headers: parseHeaderLines(headers), ...(hasBody && body ? { body } : {}) }, at)
      .catch((e: unknown): EndpointResponse => ({ ok: false, message: e instanceof Error ? e.message : String(e) }));
    if (current.current !== at || sent.current !== asked) return;
    setSending(false);
    setAnswer(r);
  };
  const shown = answer?.ok ? shownBody(answer.body, answer.headers) : null;
  return (
    <div className="ep-tester" role="group" aria-labelledby="ep-tester-label">
      <div className="ss-group-label" id="ep-tester-label">
        Test a request
      </div>
      <div className="ep-request">
        <select className="select ep-method" aria-label="Method" value={method} onChange={(e) => setMethod(e.target.value as EndpointMethod)}>
          {ENDPOINT_METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
              {methods.length && !methods.includes(m) && !methods.includes('fallback') ? ' (no handler)' : ''}
            </option>
          ))}
        </select>
        <input className="input ep-path" aria-label="Address and query" value={path} spellCheck={false} placeholder="/api/search?q=chairs" onChange={(e) => setPath(e.target.value)} />
      </div>
      <Field label="Headers" hint="One per line, as Name: value.">
        <textarea id="ep-headers" className="input ep-text" rows={2} spellCheck={false} value={headers} onChange={(e) => setHeaders(e.target.value)} />
      </Field>
      {hasBody && (
        <Field label="Body">
          <textarea id="ep-body" className="input ep-text" rows={4} spellCheck={false} value={body} placeholder={'{ "q": "chairs" }'} onChange={(e) => setBody(e.target.value)} />
        </Field>
      )}
      <div className="ep-send">
        {!previewReady && <span className="faint">The preview is starting…</span>}
        {sending ? (
          <button type="button" className="btn btn-sm" onClick={() => void api.project.stopEndpointRequest().catch(() => undefined)}>
            Stop
          </button>
        ) : (
          <button type="button" className="btn btn-sm btn-primary" disabled={!previewReady || !path.trim()} onClick={() => void send()}>
            Send
          </button>
        )}
      </div>
      <div aria-live="polite">
        {sending ? (
          <p className="faint">Waiting for the answer…</p>
        ) : answer && !answer.ok ? (
          <p className="ep-error" role="alert">
            {answer.message}
          </p>
        ) : answer?.ok ? (
          <div className="ep-answer">
            <div className="ep-status">
              <span className={`ep-code ${answer.status >= 500 ? 'is-error' : answer.status >= 400 ? 'is-warning' : 'is-ok'}`}>
                {answer.status} {answer.statusText}
              </span>
              <span className="faint">{answer.ms} ms</span>
              {shown?.json && <span className="faint">JSON</span>}
            </div>
            <details className="ep-headers">
              <summary>Response headers ({answer.headers.length})</summary>
              <pre className="ep-pre">{answer.headers.map(([n, v]) => `${n}: ${v}`).join('\n')}</pre>
            </details>
            <pre className="ep-pre ep-body" tabIndex={0} aria-label="Response body">
              {shown?.text || <span className="faint">(empty body)</span>}
            </pre>
            {answer.truncated && <p className="faint">Only the first 1 MB of the answer is shown.</p>}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The endpoints' environment variables: declared by name, each with a value kept on this computer or not. */
function EndpointVariables({ opening, readOnly }: { opening: string; readOnly: boolean }) {
  const [env, setEnv] = useState<EndpointEnvironment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [busy, setBusy] = useState(false);
  const current = useRef(opening);
  current.current = opening;
  useEffect(() => {
    const at = opening;
    void api.project
      .endpointEnvironment(at)
      .catch((e: unknown) => ({ ok: false as const, message: e instanceof Error ? e.message : String(e) }))
      .then((r) => {
        if (current.current !== at) return;
        if (r.ok) setEnv(r.environment);
        else setError(r.message);
      });
  }, [opening]);
  const reload = async () => {
    setBusy(true);
    const at = opening;
    const r = await api.project
      .reloadEndpointEnvironment(at)
      .catch((e: unknown) => ({ ok: false as const, message: e instanceof Error ? e.message : String(e) }))
      .finally(() => setBusy(false));
    if (current.current !== at) return;
    if (r.ok) {
      setEnv(r.environment);
      setError(null);
    } else setError(r.message);
  };
  const change = async (c: { name: string; declare?: boolean; value?: string | null }) => {
    setBusy(true);
    const at = opening;
    const r = await api.project
      .changeEndpointVariable(c, at)
      .catch((e: unknown) => ({ ok: false as const, message: e instanceof Error ? e.message : String(e) }))
      .finally(() => setBusy(false));
    if (current.current !== at) return false;
    if (!r.ok) {
      setError(r.message);
      return false;
    }
    setEnv(r.environment);
    setError(null);
    return true;
  };
  const add = async () => {
    const n = name.trim();
    const problem = envNameProblem(n) ?? (value ? envValueProblem(value) : null);
    if (problem) return setError(problem);
    if (await change({ name: n, declare: true, ...(value ? { value } : {}) })) {
      setName('');
      setValue('');
    }
  };
  return (
    <div className="ep-env" role="group" aria-labelledby="ep-env-label">
      <div className="ss-group-label" id="ep-env-label">
        Environment variables
      </div>
      <p className="ep-intro">
        Read in an endpoint with <code>import {'{ NAME }'} from '$app/env/private'</code>. Values typed here stay in <code>.env</code> on this computer, for the preview: they are never exported or
        saved in versions. Set them on your host where the site runs.
      </p>
      {env?.declarations === 'own' && (
        <p className="ep-note" role="note">
          <code>src/env.js</code> is your own, so SiteOrigin Builder leaves it as it is: declare new variables there too.
        </p>
      )}
      {env && env.variables.length > 0 && (
        <ul className="ep-vars" aria-label="Environment variables">
          {env.variables.map((v) => (
            <li key={v.name} className="ep-var">
              <code className="ep-var-name">{v.name}</code>
              <span className="faint ep-var-state">{!v.declared ? 'In .env, not declared' : v.local ? 'Set on this computer' : 'Not set on this computer'}</span>
              {!readOnly && (
                <span className="ep-var-actions">
                  {!v.declared && (
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void change({ name: v.name, declare: true })}>
                      Declare
                    </button>
                  )}
                  <button type="button" className="btn btn-sm" disabled={busy} onClick={() => (setEditing(editing === v.name ? null : v.name), setEditValue(''))} aria-expanded={editing === v.name}>
                    {v.local ? 'Change value' : 'Set value'}
                  </button>
                  {v.local && (
                    <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void change({ name: v.name, value: null })}>
                      Clear value
                    </button>
                  )}
                  <button type="button" className="btn btn-sm" disabled={busy} aria-label={`Remove ${v.name}`} onClick={() => void confirmDialog({ title: `Remove ${v.name}?`, body: 'Its declaration goes, and so does its value on this computer. Endpoints that read it get nothing.', subject: v.name, confirmLabel: 'Remove', tone: 'caution' }).then((ok) => ok === true && change({ name: v.name, declare: false, value: null }))}>
                    Remove
                  </button>
                </span>
              )}
              {editing === v.name && (
                <form
                  className="ep-var-edit"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const problem = envValueProblem(editValue);
                    if (problem) return setError(problem);
                    void change({ name: v.name, value: editValue }).then((ok) => ok && setEditing(null));
                  }}
                >
                  <input className="input" type="password" autoComplete="off" aria-label={`Value of ${v.name}`} value={editValue} onChange={(e) => setEditValue(e.target.value)} />
                  <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>
                    Save value
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <form
          className="ep-var-add"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <input className="input" aria-label="Variable name" placeholder="SEARCH_API_KEY" spellCheck={false} value={name} onChange={(e) => (setError(null), setName(e.target.value))} />
          <input className="input" type="password" autoComplete="off" aria-label="Value on this computer (optional)" placeholder="Value (optional)" value={value} onChange={(e) => setValue(e.target.value)} />
          <button type="submit" className="btn btn-sm" disabled={busy || !name.trim()}>
            Add variable
          </button>
        </form>
      )}
      {error && (
        <p className="ep-error" role="alert">
          {error}
        </p>
      )}
      <div className="ep-foot-row">
        <p className="faint ep-foot">Changing a variable here starts the preview again, so endpoints read the new value. Edited .env yourself? Start it again to read it.</p>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void reload()}>
          Restart preview
        </button>
      </div>
    </div>
  );
}
