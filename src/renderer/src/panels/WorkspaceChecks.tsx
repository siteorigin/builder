/**
 * The code workspace's checks (#1483): compile every Svelte file of the site and of the project's own code, run the
 * project's own tests (its package.json `test` script, as `npm test` runs it), and read what the preview's server and
 * the previewed page reported, all without leaving the app. Checks run in the main process, which sends their progress
 * (`project-check:update`); they go on while the workspace is closed, and a workspace opened again shows them.
 */
import { useEffect, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, CircleSlash, Play, Square, TriangleAlert } from 'lucide-react';
import type { PreviewLogLine, ProjectCheckRun, ProjectCheckTask } from '@shared/code-workspace';
import { defFile } from '@generator/index';
import { api, useStore } from '../store';
import { Spinner, Tabs } from '../components/ui';
import type { WorkspaceFile } from './CodeWorkspace';
import type { PreviewIssue } from './WorkspacePreview';

/** A check's run as the main process sent it, or null for anything else. */
const runOf = (r: unknown): ProjectCheckRun | null => {
  const v = r as ProjectCheckRun | null;
  return v && typeof v.runId === 'string' && (v.task === 'svelte' || v.task === 'test') && Array.isArray(v.lines) && Array.isArray(v.problems) ? v : null;
};

/** How often the preview log is read while it is on screen. */
const LOG_POLL_MS = 1500;
/** The most lines of the preview's log the panel keeps. */
const LOG_LINES = 300;

type Tab = 'svelte' | 'test' | 'log';

export function WorkspaceChecks({ opening, issues, onOpen, own }: { opening: string | null; issues: PreviewIssue[]; onOpen: (f: WorkspaceFile) => void; /** The project's own files the workspace lists: a problem in one of them opens it. */ own: ReadonlySet<string> }) {
  const [tab, setTab] = useState<Tab>('svelte');
  const [runs, setRuns] = useState<Partial<Record<ProjectCheckTask, ProjectCheckRun>>>({});
  const [refused, setRefused] = useState<Partial<Record<ProjectCheckTask, string>>>({});
  const runtime = useStore((s) => s.runtime);
  const components = useStore((s) => s.snapshot?.state.components);

  useEffect(() => {
    if (!opening) return;
    let current = true;
    const take = (run: ProjectCheckRun) => setRuns((was) => (was[run.task] && was[run.task]!.startedAt > run.startedAt ? was : { ...was, [run.task]: run }));
    void (async () => {
      let list: unknown;
      try {
        list = await api.project.checks(opening);
      } catch {
        return;
      }
      if (!current || !Array.isArray(list)) return;
      // Newest first: the newest of each kind is the one shown.
      for (const r of [...list].reverse()) {
        const run = runOf(r);
        if (run) take(run);
      }
    })();
    const off = api.on('project-check:update', (r) => {
      const run = runOf(r);
      if (current && run && run.opening === opening) take(run);
    });
    return () => {
      current = false;
      if (typeof off === 'function') off();
    };
  }, [opening]);

  const start = async (task: ProjectCheckTask) => {
    if (!opening) return;
    setRefused((r) => ({ ...r, [task]: undefined }));
    let r: Awaited<ReturnType<typeof api.project.runCheck>>;
    try {
      r = await api.project.runCheck(opening, task);
    } catch {
      r = { ok: false, message: 'The check could not be started.' };
    }
    if (r && r.ok === true && runOf(r.run)) setRuns((was) => ({ ...was, [task]: r.run }));
    else setRefused((was) => ({ ...was, [task]: r && r.ok === false ? r.message : 'The check could not be started.' }));
  };
  const stop = async (run: ProjectCheckRun) => {
    if (!opening) return;
    try {
      await api.project.stopCheck(opening, run.runId);
    } catch {
      // A run that already ended has nothing to stop.
    }
  };

  /** The workspace file a problem's file is, when it is one the workspace opens: a code component's, or the project's own. */
  const fileFor = (path: string | undefined): WorkspaceFile | null => {
    if (!path) return null;
    const def = Object.values(components ?? {}).find((d) => d.kind === 'code' && d.owner === 'project' && defFile(d) === path);
    if (def) return { kind: 'component', definitionId: def.id };
    return own.has(path) ? { kind: 'file', path } : null;
  };

  const errors = issues.length + (runtime.state === 'error' ? 1 : 0);
  return (
    <section className="cw-checks" aria-label="Checks">
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        label="Checks"
        idBase="cw-checks"
        keepMounted
        panelClassName="cw-checks-panel"
        options={[
          { value: 'svelte', label: 'Svelte check', extra: <RunMark run={runs.svelte} />, panel: () => <SvelteCheck run={runs.svelte} refused={refused.svelte} onRun={() => void start('svelte')} onOpen={onOpen} fileFor={fileFor} /> },
          { value: 'test', label: 'Tests', extra: <RunMark run={runs.test} />, panel: () => <TestRun run={runs.test} refused={refused.test} onRun={() => void start('test')} onStop={(run) => void stop(run)} /> },
          { value: 'log', label: errors ? `Preview log (${errors})` : 'Preview log', panel: () => <PreviewLog opening={opening} visible={tab === 'log'} issues={issues} /> }
        ]}
      />
    </section>
  );
}

function RunMark({ run }: { run?: ProjectCheckRun }) {
  if (!run) return null;
  if (run.status === 'running') return <Spinner decorative />;
  const Icon = run.status === 'passed' ? CircleCheck : run.status === 'failed' || run.status === 'timed-out' ? CircleAlert : CircleSlash;
  return <Icon className={`cw-run-mark ${run.status}`} aria-label={run.status === 'passed' ? 'passed' : run.status === 'failed' ? 'failed' : run.status === 'timed-out' ? 'timed out' : run.status === 'cancelled' ? 'stopped' : 'not run'} />;
}

function Summary({ run, refused, idle }: { run?: ProjectCheckRun; refused?: string; idle: string }) {
  if (refused)
    return (
      <p className="cw-check-summary failed" role="alert">
        <CircleAlert aria-hidden="true" /> {refused}
      </p>
    );
  if (!run) return <p className="cw-check-summary">{idle}</p>;
  if (run.status === 'running')
    return (
      <p className="cw-check-summary" role="status">
        <Spinner decorative /> {run.task === 'svelte' ? 'Compiling…' : 'Running the tests…'}
      </p>
    );
  return (
    <p className={`cw-check-summary ${run.status}`} role="status">
      {run.status === 'passed' ? <CircleCheck aria-hidden="true" /> : run.status === 'failed' || run.status === 'timed-out' ? <CircleAlert aria-hidden="true" /> : <CircleSlash aria-hidden="true" />} {run.summary}
      {run.endedAt && <span className="cw-check-when"> · {new Date(run.endedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>}
    </p>
  );
}

function SvelteCheck({ run, refused, onRun, onOpen, fileFor }: { run?: ProjectCheckRun; refused?: string; onRun: () => void; onOpen: (f: WorkspaceFile) => void; fileFor: (path?: string) => WorkspaceFile | null }) {
  const running = run?.status === 'running';
  return (
    <div className="cw-check">
      <div className="cw-check-head">
        <Summary run={run} refused={refused} idle="Compiles every Svelte file of the site and of your own code, as the website’s build does, saved versions only." />
        <button type="button" className="btn btn-sm" onClick={onRun} disabled={running}>
          <Play aria-hidden="true" /> {run ? 'Check again' : 'Check Svelte files'}
        </button>
      </div>
      {!!run?.problems.length && (
        <ul className="cw-check-problems">
          {run.problems.map((p, i) => {
            const target = fileFor(p.file);
            const where = `${p.file ?? ''}${p.line ? `:${p.line}` : ''}`;
            return (
              <li key={i}>
                {target ? (
                  <button type="button" className="cw-problem" onClick={() => onOpen(target)} title={`Open ${p.file}`}>
                    <span className="cw-problem-at mono">{where}</span>
                    <span className="cw-problem-text">{p.message}</span>
                  </button>
                ) : (
                  <span className="cw-problem">
                    <span className="cw-problem-at mono">{where}</span>
                    <span className="cw-problem-text">{p.message}</span>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function TestRun({ run, refused, onRun, onStop }: { run?: ProjectCheckRun; refused?: string; onRun: () => void; onStop: (run: ProjectCheckRun) => void }) {
  const running = run?.status === 'running';
  const out = useRef<HTMLPreElement>(null);
  // Following the end of the output while it comes, unless the developer scrolled up to read.
  const stuck = useRef(true);
  useEffect(() => {
    const el = out.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [run?.lines]);
  return (
    <div className="cw-check">
      <div className="cw-check-head">
        <Summary run={run} refused={refused} idle="Runs the test script in your project’s package.json, as npm test does, in the project’s folder." />
        {running ? (
          <button type="button" className="btn btn-sm" onClick={() => run && onStop(run)}>
            <Square aria-hidden="true" /> Stop
          </button>
        ) : (
          <button type="button" className="btn btn-sm" onClick={onRun}>
            <Play aria-hidden="true" /> {run ? 'Run again' : 'Run tests'}
          </button>
        )}
      </div>
      {!!run?.lines.length && (
        <pre className="cw-output" ref={out} tabIndex={0} aria-label="Test output" onScroll={(e) => (stuck.current = e.currentTarget.scrollTop + e.currentTarget.clientHeight >= e.currentTarget.scrollHeight - 8)}>
          {run.lines.join('\n')}
        </pre>
      )}
    </div>
  );
}

/** What the preview's server logged (read while the tab is on screen) and what the previewed page threw. */
function PreviewLog({ opening, visible, issues }: { opening: string | null; visible: boolean; issues: PreviewIssue[] }) {
  const runtime = useStore((s) => s.runtime);
  const [lines, setLines] = useState<PreviewLogLine[]>([]);
  const since = useRef(0);
  useEffect(() => {
    if (!opening || !visible) return;
    let current = true;
    const read = async () => {
      let got: unknown;
      try {
        got = await api.project.previewLog(opening, since.current);
      } catch {
        return;
      }
      if (!current || !Array.isArray(got) || !got.length) return;
      const fresh = (got as PreviewLogLine[]).filter((l) => typeof l.seq === 'number' && l.seq > since.current);
      if (!fresh.length) return;
      // Lines the server logged and let go of again between two reads are said to be missing, not passed over.
      const missed = since.current > 0 ? fresh[0].seq - since.current - 1 : 0;
      since.current = Math.max(since.current, ...fresh.map((l) => l.seq));
      const gap: PreviewLogLine[] = missed > 0 ? [{ seq: fresh[0].seq - 0.5, level: 'info', message: `… ${missed} line${missed === 1 ? '' : 's'} logged meanwhile are no longer kept`, time: fresh[0].time }] : [];
      setLines((was) => [...was, ...gap, ...fresh].slice(-LOG_LINES));
    };
    void read();
    const timer = setInterval(() => void read(), LOG_POLL_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [opening, visible]);
  return (
    <div className="cw-check">
      <div className="cw-check-head">
        <p className="cw-check-summary">What the preview’s server logged, and errors the previewed page threw.</p>
        <button type="button" className="btn btn-sm" onClick={() => setLines([])} disabled={!lines.length}>
          Clear
        </button>
      </div>
      {runtime.state === 'error' && (
        <p className="cw-check-summary failed" role="alert">
          <CircleAlert aria-hidden="true" /> {runtime.message}
        </p>
      )}
      {issues.map((i) => (
        <p key={`${i.at}-${i.message}`} className="cw-check-summary failed">
          <TriangleAlert aria-hidden="true" /> The page threw: {i.message}
          {i.file ? <span className="mono"> ({i.file})</span> : null}
        </p>
      ))}
      <pre className="cw-output" tabIndex={0} aria-label="Preview log">
        {lines.length
          ? lines.map((l) => (
              <span key={l.seq} className={`cw-log-line ${l.level}`}>
                {l.message}
                {'\n'}
              </span>
            ))
          : 'Nothing logged yet.'}
      </pre>
    </div>
  );
}
