/**
 * The code workspace's preview (#1483): what was last saved, beside the code. A code component is shown on its own,
 * with its default content, as Insert previews it (@shared/component-preview); anything else shows a page of the
 * site, the one open on the canvas by default, at any address of the site the developer types (a page of the
 * project's own, a concrete dynamic route). A save loads it again, which runs a changed loader or hook again too.
 *
 * The frame is one of the editor's measuring frames (MEASURING_SESSION_PREFIX), named so before it loads: it never
 * speaks for the canvas, so it acknowledges none of the updates the preview's server waits on the canvas for, and a
 * load that fails in it is never taken for the canvas's (index.ts names the frame that failed). It shows the page as
 * visitors see it.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Globe, RefreshCw, TriangleAlert } from 'lucide-react';
import { api, useStore } from '../store';
import { Spinner } from '../components/ui';
import { acceptMessage, newSessionId, postToFrame, viewAfter, type FrameView } from '../lib/bridge';
import { MEASURING_SESSION_PREFIX } from '../lib/measuring-frame';
import { StudioLoads } from '../lib/studio';
import { shownView } from '../lib/template-view';
import type { WorkspaceFile } from './CodeWorkspace';

/** An error the previewed page reported (it threw), for the workspace's checks to list. */
export interface PreviewIssue {
  message: string;
  file?: string;
  at: number;
}

/** How long a component's preview gets to be prepared before the pane says it could not be. */
const PREPARE_MS = 15_000;

/** A site address as typed: a path that starts at the site's root, or null when it is not one. */
export function sitePath(typed: string): string | null {
  const t = typed.trim();
  if (!t.startsWith('/') || t.startsWith('//') || /[\s\\]/.test(t)) return null;
  try {
    const u = new URL(t, 'http://site.invalid');
    return u.origin === 'http://site.invalid' ? `${u.pathname}${u.search}${u.hash}` : null;
  } catch {
    return null;
  }
}

export function WorkspacePreview({ file, saves, onIssues }: { file: WorkspaceFile | null; saves: number; onIssues: (issues: PreviewIssue[]) => void }) {
  const runtime = useStore((s) => s.runtime);
  const def = useStore((s) => (file?.kind === 'component' ? s.snapshot?.state.components[file.definitionId] : undefined));
  // What the canvas shows (a page, or a collection's entry or index layout), where the page preview starts.
  const pageRoute = useStore((s) => (s.snapshot ? (shownView(s.snapshot.state, s.pageId, s.templateMode)?.route ?? undefined) : undefined));
  const ready = runtime.state === 'ready' ? runtime.url : null;
  const component = file?.kind === 'component' && def ? def : null;
  // The address being typed, or null while the field shows where the preview is.
  const [typed, setTyped] = useState<string | null>(null);
  // The prepared component preview (its address, and the component it shows), and why there is none.
  const [prepared, setPrepared] = useState<{ path: string; definitionId: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const loads = useMemo(() => new StudioLoads((key) => void api.project.releaseComponentPreview(key).catch(() => undefined)), []);
  useEffect(() => () => loads.end(), [loads]);
  // The page a page preview loads, and a new load of the frame each time (a save, a component prepared, an address).
  const [page, setPage] = useState<string | null>(null);
  const [load, setLoad] = useState(0);
  // Where the page preview's frame is now: the page it was given, or where its links have taken it since.
  const at = useRef<string | null>(null);
  const showing = useRef<'component' | 'page'>('page');
  showing.current = component ? 'component' : 'page';
  // A component preview is prepared again whenever what it shows may have changed: its code, its properties, a save,
  // the preview's server.
  // Reload asks for it again too, which retries one that could not be prepared.
  const [retries, setRetries] = useState(0);
  const componentKey = component ? JSON.stringify([component.id, component.source ?? '', component.properties, ready, saves, retries]) : null;
  useEffect(() => {
    if (!componentKey || !component || !ready) {
      // No component shown any more (a file is open now, or the server stopped): its preview's files are let go of.
      loads.end();
      setPrepared(null);
      // What went wrong preparing it was about it alone.
      setProblem(null);
      return;
    }
    const request = loads.begin();
    setProblem(null);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled || !loads.latest(request)) return;
      settled = true;
      setProblem('The component preview took too long to prepare.');
    }, PREPARE_MS);
    const id = component.id;
    void (async () => {
      let r: Awaited<ReturnType<typeof api.project.prepareComponentPreview>> | null;
      try {
        r = await api.project.prepareComponentPreview({ definitionId: id });
      } catch (e) {
        clearTimeout(timer);
        if (!settled && loads.latest(request)) setProblem(`The component preview could not be prepared: ${e instanceof Error ? e.message : String(e)}`);
        settled = true;
        return;
      }
      clearTimeout(timer);
      if (!r || r.ok !== true) {
        if (!settled && loads.latest(request)) setProblem(r && r.ok === false ? r.message : 'The component preview could not be prepared.');
        settled = true;
        return;
      }
      // Prepared after a later request, or after the pane gave up on it: let go of at once.
      if (settled || !loads.prepared(request, r.key)) {
        if (settled) void api.project.releaseComponentPreview(r.key).catch(() => undefined);
        return;
      }
      settled = true;
      setPrepared({ path: r.path, definitionId: id });
      setLoad((n) => n + 1);
    })();
    return () => clearTimeout(timer);
  }, [componentKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Load the page preview again, where its frame is now (the canvas's page to begin with). */
  const showPage = (path = at.current ?? pageRoute ?? '/') => {
    setPage(path);
    setLoad((n) => n + 1);
  };
  // After each save, where the frame is by then: a changed loader or hook runs again.
  useEffect(() => {
    if (!component && ready) showPage();
  }, [saves, ready, !!component]); // eslint-disable-line react-hooks/exhaustive-deps
  const reload = () => (component ? setRetries((n) => n + 1) : showPage());

  // Only ever the preview of the component open now: one prepared for another is not shown meanwhile.
  const src = !ready ? null : component ? (prepared?.definitionId === component.id ? ready + prepared.path : null) : page !== null ? ready + page : null;
  const origin = ready ? new URL(ready).origin : null;
  const session = useMemo(() => MEASURING_SESSION_PREFIX + newSessionId(), []);
  const frame = useRef<HTMLIFrameElement>(null);
  const view = useRef<FrameView | null>(null);
  const [shownPath, setShownPath] = useState<string | null>(null);
  const issues = useRef<PreviewIssue[]>([]);
  const told = useRef(onIssues);
  told.current = onIssues;
  useEffect(() => {
    view.current = null;
    issues.current = [];
    told.current([]);
  }, [load]);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const m = acceptMessage(e, frame.current, origin, session, view.current);
      if (!m) return;
      view.current = viewAfter(m, view.current);
      const p = m.payload as { path?: unknown; message?: unknown; file?: unknown; preview?: { mounted?: unknown; error?: unknown } };
      if (m.type === 'ready') {
        // Shown as visitors see it.
        postToFrame(frame.current, origin, session, 'mode', { mode: 'preview' }, view.current);
        if (typeof p.path === 'string' && showing.current === 'page') arrived(p.path);
        if (p.preview && p.preview.mounted === false) add({ message: typeof p.preview.error === 'string' ? `The component could not be shown: ${p.preview.error}` : 'The component could not be shown.', at: Date.now() });
      } else if (m.type === 'navigated' && typeof p.path === 'string' && showing.current === 'page') arrived(p.path);
      else if (m.type === 'runtimeError' && typeof p.message === 'string') add({ message: p.message.slice(0, 400), ...(typeof p.file === 'string' ? { file: p.file } : {}), at: Date.now() });
    };
    // The page the frame reports (a path, without the query or fragment it was asked for): an address the developer
    // typed for that same page keeps its query, so a reload asks a loader for the same thing again.
    const arrived = (path: string) => {
      if (at.current === null || at.current.replace(/[?#].*$/, '') !== path) at.current = path;
      setShownPath(at.current);
    };
    const add = (issue: PreviewIssue) => {
      issues.current = [...issues.current.filter((i) => i.message !== issue.message), issue].slice(-20);
      told.current(issues.current);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [origin, session]);
  // A load that failed in this frame (the server stopped, the address has nothing): said here, never on the canvas.
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => setLoadFailed(false), [load]);
  useEffect(() => api.on('preview:load-failed', (f) => f && f.frame === session && setLoadFailed(true)), [session]);

  const go = (e: FormEvent) => {
    e.preventDefault();
    const path = typed === null ? null : sitePath(typed);
    if (!path || !ready) return;
    at.current = path;
    // An address that answers without a page (an endpoint's JSON) says nothing back: the field shows it anyway.
    setShownPath(path);
    setTyped(null);
    showPage(path);
  };
  // Escape puts back where the preview is, without closing the workspace.
  const escape = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Escape' || typed === null) return;
    e.preventDefault();
    e.stopPropagation();
    setTyped(null);
  };
  const where = shownPath ?? pageRoute ?? '/';
  const heading = component ? `${component.name}, on its own` : where;
  return (
    <section className="cw-preview" aria-label="Preview">
      <div className="cw-preview-head">
        {component ? (
          <span className="cw-preview-what grow" title={heading}>
            {heading}
          </span>
        ) : (
          <form className="cw-preview-address grow" onSubmit={go}>
            <Globe aria-hidden="true" />
            <input
              className="input input-sm mono"
              aria-label="Preview address"
              title="An address of the site, such as /about. Press Enter to show it."
              value={typed ?? where}
              onFocus={() => setTyped(where)}
              onChange={(e) => setTyped(e.target.value)}
              onBlur={() => setTyped(null)}
              onKeyDown={escape}
              spellCheck={false}
              aria-invalid={typed !== null && typed.trim() !== '' && !sitePath(typed) ? 'true' : undefined}
            />
          </form>
        )}
        <button type="button" className="icon-btn" onClick={reload} disabled={!ready || (!src && !component)} aria-label="Reload the preview" title="Reload the preview">
          <RefreshCw aria-hidden="true" />
        </button>
      </div>
      <div className="cw-preview-frame">
        {runtime.state !== 'ready' ? (
          <PreviewState runtime={runtime} />
        ) : problem ? (
          <p className="cw-preview-note" role="alert">
            <TriangleAlert aria-hidden="true" /> {problem}
          </p>
        ) : !src ? (
          <p className="cw-preview-note">
            <Spinner decorative /> Preparing the preview…
          </p>
        ) : (
          <>
            {/* Named before it loads, so its page knows from its first moment that it does not speak for the canvas. */}
            <iframe key={load} ref={frame} name={session} title={component ? `${component.name} preview` : 'Page preview'} src={src} sandbox="allow-scripts allow-same-origin allow-forms" />
            {loadFailed && (
              <p className="cw-preview-note over" role="alert">
                <TriangleAlert aria-hidden="true" /> This address did not load. Check the preview log below, then reload.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function PreviewState({ runtime }: { runtime: ReturnType<typeof useStore.getState>['runtime'] }) {
  if (runtime.state === 'error' || runtime.state === 'unavailable')
    return (
      <div className="cw-preview-note" role="alert">
        <TriangleAlert aria-hidden="true" />
        <span className="grow">{runtime.message}</span>
        {runtime.state === 'error' && (
          <button type="button" className="btn btn-sm" onClick={() => void api.project.retryPreview()}>
            Try again
          </button>
        )}
      </div>
    );
  return (
    <p className="cw-preview-note">
      <Spinner decorative /> {runtime.state === 'preparing' ? runtime.message : 'Starting the preview…'}
    </p>
  );
}
