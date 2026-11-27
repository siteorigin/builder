import './SourceModal.css';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { CircleAlert, CircleCheck, Code, FileCode2, Lock, Sparkles } from 'lucide-react';
import { applyOps, api, markDraft, setState, toast, useStore, confirmDialog } from '../store';
import { CODE_DRAFT } from '../lib/pending';
import { Field, Modal, Spinner, Tabs } from '../components/ui';
import { insert } from '../lib/actions';
import { prepareCodeForSave } from '../lib/code';
import { CodeEditor, type CodeEditorHandle } from '../components/CodeEditor';
import { PropSchemaEditor, hiddenEdits, propertiesFromRows, renamesFromRows, rowsFromProperties, schemaProblems, type SchemaRow } from './PropSchemaEditor';
import { propertiesHash } from '@shared/ops';
import { CODE_STARTER, CODE_STARTER_PROPERTIES } from '@shared/code-starter';
import { pageFile } from '@generator/index';

/** False once the modal has closed; closing also cancels an automatic code fix still running. */
function useAlive(): () => boolean {
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
      void api.ai.cancelFix();
    };
  }, []);
  return () => open.current;
}

/** Problems that say what to do next rather than what is wrong in the code. */
const isAdvice = (p: string) => /^(Connect an AI provider|The automatic fix did not work|Your code could not be checked|The save did not finish|Creating the component did not finish)/.test(p);
/** Advice about the AI repair, marked with the AI's icon. */
const isAiAdvice = (p: string) => /^(Connect an AI provider|The automatic fix did not work)/.test(p);
const CHECK_FAILED = 'Your code could not be checked, so it was not saved. Try again.';
const WRITE_FAILED = 'The save did not finish. Your edits are still here, so you can try again.';
const CREATE_CHECK_FAILED = 'Your code could not be checked, so the component was not created. Try again.';
const CREATE_FAILED = 'Creating the component did not finish. Your work is still here, so you can try again.';
/** Said when the project changed under unsaved edits to the properties: saving those would undo that change. */
const STALE_PROPERTIES = 'The project changed while you were editing these properties (an undo or the AI). Saving them would undo that: Revert to start again from the saved ones.';

/** Properties fields commit on blur: commit one still being typed in, and return it so it can have focus back. */
const commitField = () => {
  const a = document.activeElement;
  if (!(a instanceof HTMLElement) || !a.closest('.code-props') || !a.matches('input, textarea')) return null;
  a.blur();
  return a;
};
const firstLine = (problems: string[]) => {
  for (const p of problems) {
    const at = /^Line (\d+):/.exec(p);
    if (at) return Number(at[1]);
  }
  return null;
};

/** Runs the real check and shows what it finds. It never writes, whatever the live check last said. */
async function reviewCode(code: string, alive: () => boolean, ui: { setBusy: (b: boolean) => void; setStatus: (s: string | null) => void; setErrors: (p: string[]) => void; clearLive: () => void }) {
  ui.setBusy(true);
  try {
    const r = await prepareCodeForSave(code, ui.setStatus, alive);
    if (!alive()) return;
    if (r.ok) return ui.clearLive();
    // The caret stays where the person left it: each listed problem goes to its line when they choose it.
    ui.setErrors(r.problems);
  } catch {
    ui.setErrors([CHECK_FAILED]);
  } finally {
    ui.setStatus(null);
    ui.setBusy(false);
  }
}

/** Marks a tab with unsaved work. It sits in the tab's own padding, so the tabs never shift and the underline
 *  keeps to the label. */
function TabDot({ on }: { on: boolean }) {
  return on ? <span className="code-dot code-tab-dot" role="img" aria-label="unsaved" /> : null;
}

/** The dialog's badge: a component definition in its own hue (edits reach every page that uses it), a page in
 *  neutral. */
function CodeBadge({ kind }: { kind: 'component' | 'page' }) {
  return <span className={`code-badge ${kind}`}>{kind === 'page' ? <FileCode2 aria-hidden="true" /> : <Code aria-hidden="true" />}</span>;
}

function SourceLoading({ failed, what, onRetry }: { failed: boolean; what: string; onRetry: () => void }) {
  return failed ? (
    <div className="code-loading" role="alert">
      <span>{what} could not be loaded.</span>
      <button className="btn btn-sm" onClick={onRetry}>
        Try again
      </button>
    </div>
  ) : (
    <div className="code-loading" role="status">
      <Spinner decorative /> Loading source…
    </div>
  );
}

/** The dialog's heading: what this is, whether it can be changed, and which file it is. */
function CodeTitle({ name, file, state }: { name: string; file?: string; state?: 'unsaved' | 'draft' | 'readonly' | null }) {
  return (
    <span className="code-title">
      <span className="code-title-row">
        <span className="code-title-name">{name}</span>
        {(state === 'unsaved' || state === 'draft') && (
          <span className="code-chip unsaved">
            <span className="code-dot" aria-hidden="true" /> {state === 'draft' ? 'Unsaved draft' : 'Unsaved changes'}
          </span>
        )}
        {state === 'readonly' && (
          <span className="code-chip readonly">
            <Lock aria-hidden="true" /> Read only
          </span>
        )}
      </span>
      {file && (
        <span className="code-title-file" title={file}>
          {file}
        </span>
      )}
    </span>
  );
}

/** Why a save did not happen, in one place. The head line is announced; each located problem is a button that
 *  goes to its line. Focus comes here when the save was asked for from outside the code. */
function SaveProblems({ problems, onGoTo, focusRef, heading = 'Not saved' }: { problems: string[]; onGoTo: (line: number) => void; focusRef: RefObject<HTMLElement | null>; heading?: string }) {
  const headId = useId();
  if (!problems.length) return null;
  const faults = problems.filter((p) => !isAdvice(p));
  const advice = problems.filter(isAdvice);
  // Compiler errors each have a line; anything else (a property, a check that failed) is a problem.
  const noun = faults.every((p) => /^Line \d+:/.test(p)) ? 'error' : 'problem';
  return (
    <section ref={focusRef} className="code-problems" aria-labelledby={headId} tabIndex={-1}>
      <p className="code-problems-head" id={headId}>
        <CircleAlert aria-hidden="true" />
        <strong>{heading}</strong>
        {faults.length > 0 && <span className="code-problems-count">{`${faults.length} ${noun}${faults.length === 1 ? '' : 's'} to fix`}</span>}
      </p>
      {faults.length > 0 && (
        <ul className="code-problems-list">
          {faults.map((p, i) => {
            const at = /^Line (\d+): (.*)$/s.exec(p);
            return (
              <li key={i}>
                {at ? (
                  <button type="button" className="code-problem" onClick={() => onGoTo(Number(at[1]))} title={`Go to line ${at[1]}`}>
                    <span className="code-problem-line">Line {at[1]}</span>
                    <span className="code-problem-text">{at[2]}</span>
                  </button>
                ) : (
                  <span className="code-problem">
                    <span className="code-problem-text">{p}</span>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {advice.map((p, i) => (
        <p key={i} className="code-problems-advice">
          {isAiAdvice(p) && <Sparkles aria-hidden="true" />}
          <span>{p}</span>
        </p>
      ))}
    </section>
  );
}

/** Escape in a Properties field cancels that field's text; it never also closes the dialog. */
const keepDialogOnFieldEscape = (e: KeyboardEvent<HTMLDivElement>) => {
  if (e.key === 'Escape' && (e.target as HTMLElement).matches('input, textarea')) e.stopPropagation();
};
const isSaveKey = (e: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'key'>) => (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's';
const busyLabel = (status: string | null, writing = 'Saving…') => (status?.includes('Fixing') ? 'Fixing…' : status ? 'Checking…' : writing);
/** Progress said with a real ellipsis, whatever the checker wrote. */
const tidy = (status: string | null) => status?.replace(/\.{3}$/, '…') ?? null;
const SAVE_KEYS = 'Meta+S Control+S';
const saveTitle = (label: string) => `${label} (${api.platform === 'darwin' ? '⌘S' : 'Ctrl+S'})`;
const count = (n: number, one: string) => (n === 1 ? `the ${one}` : `the ${n} ${one}s`);

/** Cmd/Ctrl+S anywhere in the dialog (its header and footer too) runs `run`. The code editor handles its own
 *  press, and a prompt over the dialog is outside it, so neither runs this twice. */
function useSaveKey(inside: RefObject<HTMLElement | null>, run: () => void) {
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    const dialog = inside.current?.closest('.modal');
    if (!dialog) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!isSaveKey(e)) return;
      e.preventDefault();
      latest.current();
    };
    dialog.addEventListener('keydown', onKey as EventListener);
    return () => dialog.removeEventListener('keydown', onKey as EventListener);
  }, [inside]);
}

/**
 * Keeps keyboard focus in the dialog when the control that had it goes away: Save disabling itself once saved or
 * blocked, a conflict note's choice, Revert once nothing is left to revert. Focus goes to the first listed problem
 * when there is one, else to the code, else to the open tab. Focus that is still on something usable is left alone.
 */
function useFocusKeeper(inside: RefObject<HTMLElement | null>, alive: () => boolean, list: RefObject<HTMLElement | null>, fallback: () => void) {
  const last = useRef<HTMLElement | null>(null);
  const restore = useRef(fallback);
  restore.current = fallback;
  useEffect(() => {
    const dialog = inside.current?.closest('.modal');
    if (!dialog) return;
    const onIn = (e: Event) => (last.current = e.target as HTMLElement);
    dialog.addEventListener('focusin', onIn);
    return () => dialog.removeEventListener('focusin', onIn);
  }, [inside]);
  useEffect(() => {
    const t = setTimeout(() => {
      // A control that disables itself can stay the active element, so disabled counts as gone too.
      const usable = (el: Element | null) => !!el && el !== document.body && el.isConnected && !(el as HTMLButtonElement).disabled;
      const was = last.current;
      if (!alive() || !was || usable(document.activeElement) || usable(was)) return;
      const problem = list.current?.querySelector<HTMLElement>('button.code-problem');
      if (problem) problem.focus();
      else restore.current();
    });
    return () => clearTimeout(t);
  });
}

/** Property problems live in the Properties table, row by row, with its own count: a save refused on them opens
 *  that tab and puts focus on the count, rather than listing the same problems again below. */
function showPropertyProblems(setTab: (t: 'source' | 'manifest') => void) {
  setTab('manifest');
  setTimeout(() => document.querySelector<HTMLElement>('.code-dialog .schema-problems')?.focus());
}
const propertyNote = (n: number, onTab: boolean, verb: string) => `Fix ${n === 1 ? 'the property problem' : `the ${n} property problems`}${onTab ? ' in the table' : ' on the Properties tab'} to ${verb}.`;

/** The verdict of a refused save, said once and politely; the list itself is not a live region. */
function refusal(problems: string[], heading = 'Not saved'): string {
  if (!problems.length) return '';
  const faults = problems.filter((p) => !isAdvice(p));
  const noun = faults.every((p) => /^Line \d+:/.test(p)) ? 'error' : 'problem';
  return faults.length ? `${heading}. ${faults.length} ${noun}${faults.length === 1 ? '' : 's'} to fix.` : `${heading}. ${problems[0]}`;
}

export function SourceModal({ definitionId }: { definitionId: string }) {
  const def = useStore((s) => s.snapshot?.state.components[definitionId]);
  const canFix = useStore((s) => !!s.providers.find((p) => p.id === s.settings?.ai.provider)?.configured);
  const [src, setSrc] = useState<{ source: string; hash: string; path: string; editable: boolean } | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  // The person's edits, or null while there are none. The code shown is never a blank waiting to be saved.
  const [edit, setEdit] = useState<string | null>(null);
  // The stored code the edits were made from. A newer version arriving underneath them is a conflict to settle,
  // never a base to save the older edits onto.
  const [baseHash, setBaseHash] = useState<string | null>(null);
  // An explicit check found nothing wrong: say so, and leave saving to the person.
  const [checkedOk, setCheckedOk] = useState(false);
  const [tab, setTab] = useState<'source' | 'manifest'>('source');
  const tabNow = useRef(tab);
  tabNow.current = tab;
  const [errors, setErrors] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  // One save at a time: its code and properties are held still from the check through the write.
  const [saving, setSaving] = useState(false);
  const [writing, setWriting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [liveErrors, setLiveErrors] = useState(0);
  const [liveLine, setLiveLine] = useState<number | undefined>();
  // The live check is still to report on the code as it stands: until it does, its last count says nothing.
  const [liveChecking, setLiveChecking] = useState(true);
  const editor = useRef<CodeEditorHandle | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const problemsList = useRef<HTMLElement | null>(null);
  // A discard prompt still open: a save waits for its answer before it writes anything.
  const discarding = useRef<Promise<boolean | null> | null>(null);
  const latest = useRef({ close: () => {}, save: () => {}, request: () => {} });
  useSaveKey(body, () => latest.current.request());
  // Closing the editor cancels an automatic fix that is still running, and a save in progress.
  const alive = useAlive();
  useFocusKeeper(body, alive, problemsList, () => (tabNow.current === 'source' ? editor.current?.focus() : document.getElementById('source-tab-manifest')?.focus()));
  const [rows, setRows] = useState<SchemaRow[]>(() => rowsFromProperties(def?.properties ?? {}));
  // The stored properties the rows were made from: what their edits are measured, and saved, against.
  const [savedProps, setSavedProps] = useState(() => JSON.stringify(def?.properties ?? {}));
  // A Properties field being typed in: its text commits when Save is pressed, so Save is ready already.
  const [typing, setTyping] = useState(false);
  // Re-read when the stored source changes; unsaved edits are kept.
  useEffect(() => {
    let current = true;
    // A failure stands until a read succeeds: while a retry is on its way, the code shown is still unconfirmed.
    setLoading(true);
    api.project.readSource(definitionId).then(
      (r) => {
        if (!current) return;
        setSrc(r);
        setLoadFailed(false);
        setLoading(false);
        setEdit((e) => (e === r.source ? null : e));
      },
      () => current && (setLoadFailed(true), setLoading(false))
    );
    return () => {
      current = false;
    };
  }, [definitionId, def?.source, reload]);
  // A saved (or undone) manifest replaces the rows, unless there are unsaved edits to them or one is being typed.
  // Those keep the schema they were made from as their baseline, so a change underneath them (undo, the AI, an edit
  // outside the app) is seen.
  const propsKey = JSON.stringify(def?.properties ?? {});
  // A rename is an edit even when the schemas read the same, and so are two rows with one name.
  const propsDirty = JSON.stringify(propertiesFromRows(rows)) !== savedProps || renamesFromRows(rows).length > 0 || hiddenEdits(rows);
  // Text still being typed in a field is an edit made from that baseline too.
  const propsStale = (propsDirty || typing) && propsKey !== savedProps;
  // The stored properties last taken into account: only a change since then refreshes the rows, so a snapshot that
  // arrives after a save never puts back the properties from before it.
  const seenKey = useRef(propsKey);
  // The project revision while the rows were last clean: a rename moves placement content by name, so it is saved
  // only onto the project its edits were made against.
  const revision = useStore((s) => s.snapshot?.revision);
  const cleanAt = useRef(revision);
  // Rows replaced from the stored schema start a new generation: an edit still on its way from a field of the rows
  // before (a field that commits as it unmounts) is dropped rather than put back over them.
  const generation = useRef(0);
  const made = generation.current;
  const latestDef = useRef(def);
  latestDef.current = def;
  useEffect(() => {
    if (propsDirty || typing) return;
    // Only ever forward: a push the store has yet to receive must not undo what a save already recorded.
    cleanAt.current = Math.max(cleanAt.current ?? 0, revision ?? 0);
    if (propsKey === seenKey.current) return;
    seenKey.current = propsKey;
    if (propsKey === savedProps) return;
    generation.current++;
    setRows(rowsFromProperties(def?.properties ?? {}));
    setSavedProps(propsKey);
  }, [propsKey, propsDirty, typing, revision]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Take the stored schema as it is now, dropping the edits made to the rows. Unsaved Svelte source is kept. */
  const reloadProps = () => {
    const now = JSON.stringify(latestDef.current?.properties ?? {});
    generation.current++;
    setRows(rowsFromProperties(latestDef.current?.properties ?? {}));
    setSavedProps(now);
    seenKey.current = now;
    setErrors([]);
  };
  const code = edit ?? src?.source ?? '';
  const codeDirty = !!src && edit !== null && edit !== src.source;
  const dirty = !!src && (codeDirty || propsDirty || typing);
  // Leaving the project (closing the window, quitting) asks about unsaved code, as closing this editor does.
  const unsavedCode = !!src?.editable && dirty;
  useEffect(() => {
    markDraft(CODE_DRAFT, unsavedCode);
    return () => markDraft(CODE_DRAFT, false);
  }, [unsavedCode]);
  useEffect(() => {
    if (edit === null) setBaseHash(null);
  }, [edit]);
  // Edits made from an older version of the code (an undo, the AI or an outside edit changed it since).
  const codeStale = codeDirty && !!baseHash && !!src && src.hash !== baseHash;
  if (!def) return null;
  const changed = codeDirty && propsDirty ? 'code and properties' : codeDirty ? 'code' : 'properties';
  // Unsaved code is never lost to Escape, the backdrop or ×: ask first. Nothing closes during the write itself.
  const close = () => {
    if (writing || discarding.current) return;
    if (!dirty || !src?.editable) return void setState({ modal: null });
    const asked = confirmDialog({
      title: 'Discard your changes?',
      body: `The editor closes without saving your changes to the ${changed}.`,
      subject: def.name,
      subjectKind: 'component',
      details: [
        { kind: 'keep', text: 'The last saved version stays on your site.' },
        { kind: 'final', text: 'Unsaved changes can’t be brought back.' }
      ],
      confirmLabel: 'Discard changes',
      cancelLabel: 'Keep editing',
      tone: 'caution',
      icon: 'discard'
    });
    discarding.current = asked;
    void asked.then((ok) => {
      discarding.current = null;
      if (ok === true) setState({ modal: null });
    });
  };
  const requestClose = () => (commitField() ? void setTimeout(() => latest.current.close()) : close());
  const goToLine = (line: number) => {
    setTab('source');
    setTimeout(() => editor.current?.goTo(line));
  };
  const changeCode = (v: string) => {
    setEdit(v);
    setBaseHash((b) => b ?? src?.hash ?? null);
    setCheckedOk(false);
    setSaved(false);
    setErrors((e) => (e.length ? [] : e));
  };
  const changeRows = (next: SchemaRow[]) => {
    if (made !== generation.current) return;
    setRows(next);
    setSaved(false);
    setCheckedOk(false);
    setErrors((e) => (e.length ? [] : e));
  };
  /** Settle a code conflict: take the newer code (Undo in the editor brings the edits back), or keep the edits. */
  const takeNewerCode = () => {
    setEdit(null);
    setErrors([]);
    setCheckedOk(false);
  };
  const keepMyCode = () => setBaseHash(src?.hash ?? null);
  const revert = async () => {
    const ok = await confirmDialog({
      title: 'Revert your changes?',
      body: `The ${changed} ${changed === 'code' ? 'goes' : 'go'} back to the last saved version. The editor stays open.`,
      subject: def.name,
      subjectKind: 'component',
      details: [
        ...(codeDirty ? [{ kind: 'undo' as const, text: 'Undo in the code editor brings your code changes back.' }] : []),
        ...(propsDirty ? [{ kind: 'final' as const, text: 'Property changes can’t be brought back.' }] : [])
      ],
      confirmLabel: 'Revert changes',
      cancelLabel: 'Keep editing',
      // Code alone comes back with Undo, so only a reset of the properties is a loss.
      tone: propsDirty ? 'caution' : 'neutral',
      icon: 'revert'
    });
    if (ok !== true) return;
    setEdit(null);
    reloadProps();
  };
  const save = async () => {
    if (!src?.editable || !dirty || saving) return;
    setErrors([]);
    setSaved(false);
    if (propsStale) return setTab('manifest');
    if (codeStale) return setTab('source');
    if (propsDirty && schemaProblems(rows).length) return showPropertyProblems(setTab);
    let wrote = false;
    setSaving(true);
    try {
      const r = await prepareCodeForSave(code, setStatus, alive);
      if (!r.ok) return setErrors(r.problems);
      while (discarding.current) if ((await discarding.current) === true) return;
      if (!alive()) return;
      const properties = propsDirty ? propertiesFromRows(rows) : undefined;
      // A renamed property takes every placement's content with it.
      const renames = properties ? renamesFromRows(rows) : [];
      // Edits to properties that changed since the rows were made would undo that change, whatever it was.
      const snap = useStore.getState().snapshot;
      const storedKey = JSON.stringify(snap?.state.components[definitionId]?.properties ?? {});
      if (properties && (storedKey !== savedProps || (renames.length && snap?.revision !== cleanAt.current))) return (setErrors([STALE_PROPERTIES]), setTab('manifest'));
      wrote = true;
      setWriting(true);
      // The schema the rows were edited from: the engine refuses the save if the stored one changed meanwhile.
      const schema = properties ? { properties, expectedPropertiesHash: propertiesHash(JSON.parse(savedProps)), ...(renames.length ? { renames } : {}) } : {};
      // Saved onto the version the edits were made from: the engine refuses it if the stored code moved meanwhile.
      if (!(await applyOps([{ type: 'component.updateSource', definitionId, source: r.source, expectedHash: baseHash ?? src.hash, ...schema }], `Edit ${def.name} source`, undefined, properties ? snap?.revision : undefined)))
        return setErrors([WRITE_FAILED]);
      // A repaired save shows the code that was stored; undo in the editor still reaches what was typed.
      if (r.source !== code) setEdit(r.source);
      if (properties) {
        // Show the schema as the engine stored it (filled defaults, trimmed labels), even when nothing changed.
        // The write has landed. If this refresh fails, the next project update brings the stored schema.
        const fresh = await api.project.snapshot().catch(() => null);
        const stored = fresh?.state.components[definitionId]?.properties;
        if (stored) {
          cleanAt.current = Math.max(cleanAt.current ?? 0, fresh.revision);
          // The store still showing the properties from before the save is behind: its next push is this save, not
          // a change to show. Anything else it shows by now is newer, and refreshes the rows.
          const now = JSON.stringify(useStore.getState().snapshot?.state.components[definitionId]?.properties ?? {});
          seenKey.current = now === storedKey ? now : JSON.stringify(stored);
          generation.current++;
          setRows(rowsFromProperties(stored));
          setSavedProps(JSON.stringify(stored));
        }
      }
      // Save disables itself once the refreshed code shows nothing left to save; the focus keeper hands focus on.
      setSaved(true);
      if (r.fixed) toast(`Fixed and saved: ${r.fixed}`);
      else if (r.warnings?.length) toast(`Saved with ${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'}. ${r.warnings[0]}`);
    } catch {
      setErrors([wrote ? WRITE_FAILED : CHECK_FAILED]);
    } finally {
      setStatus(null);
      setWriting(false);
      setSaving(false);
    }
  };
  // The label, the note and the handler all read this one settled count.
  const settledErrors = liveChecking ? 0 : liveErrors;
  const reviewing = dirty && settledErrors > 0 && !canFix;
  // The check has listed errors that nothing here can repair: Save waits for an edit.
  const listed = errors.some((p) => !isAdvice(p));
  // The code on screen could not be brought up to date: what it is based on is unknown until it loads.
  const refreshFailed = loadFailed && !!src;
  // Property problems the table shows in place. Text still being typed counts once it commits, which Save does.
  const propIssues = propsDirty && !typing ? schemaProblems(rows).length : 0;
  // Save waits: for an edit when the listed errors can't be repaired here, for a choice between two versions, for
  // the latest code to load, or for the property problems to be fixed.
  const blocked = (reviewing && listed) || codeStale || refreshFailed || propIssues > 0;
  const reviewErrors = () => {
    if (saving) return;
    const line = firstLine(errors);
    if (line) return goToLine(line);
    void reviewCode(code, alive, { setBusy: setSaving, setStatus, setErrors, clearLive: () => (setLiveErrors(0), setCheckedOk(true)) });
  };
  // Cmd/Ctrl+S from a Properties field saves what is typed in it. An edit the live check has not reported on yet
  // goes to the real check, which decides on the code as it is now. While Save is disabled, so is the shortcut.
  const requestSave = () => {
    if (!src?.editable || blocked) return;
    // Newer properties are waiting: Save takes you to the notice that settles it.
    if (propsStale) {
      setTab('manifest');
      return void setTimeout(() => document.querySelector<HTMLElement>('.code-dialog .source-stale.props .btn')?.focus());
    }
    if (reviewing && !editor.current?.checking()) return reviewErrors();
    const field = commitField();
    if (!field) return void save();
    setTimeout(() => {
      latest.current.save();
      field.focus();
    });
  };
  latest.current = { close, save: () => void save(), request: requestSave };
  // Saved stays on screen only while nothing new is waiting, typed-in-but-uncommitted fields included.
  const justSaved = saved && !dirty && !status;
  const busy = !!status || writing;
  const action = reviewing ? 'Review errors' : dirty && settledErrors && canFix ? 'Fix and save' : 'Save';
  // What the footer says, in order of what matters most right now.
  const footNote = () => {
    if (status) return tidy(status);
    if (writing) return 'Saving…';
    if (justSaved) return 'Saved. Every page using this component is updated.';
    if (!dirty) return 'No unsaved changes';
    if (refreshFailed) return 'Saving waits until the latest code loads.';
    if (codeStale) return 'Choose which version of the code to keep before saving.';
    if (propsStale) return 'Reload the current properties before saving.';
    if (propIssues) return propertyNote(propIssues, tab === 'manifest', 'save');
    if (blocked) return `Fix ${count(settledErrors, 'error')} listed above, then save.`;
    if (listed) return action === 'Fix and save' ? 'Fix what is listed above, or try Fix and save again.' : 'Fix what is listed above, then save again.';
    if (errors.length) return 'Try saving again.';
    if (checkedOk) return 'Your code passed the check. Save to update every page using this component.';
    if (reviewing) return `Fix ${count(settledErrors, 'error')}${liveLine && settledErrors === 1 ? ` on line ${liveLine}` : ''} to save.`;
    if (settledErrors) return 'Save repairs the errors, then updates every page using this component.';
    return 'Save checks your code, then updates every page using this component.';
  };
  const note = footNote();
  const saveHint = !dirty || blocked || propsStale ? null : reviewing ? 'reviews errors' : action === 'Fix and save' ? 'fixes and saves' : 'saves';
  return (
    <Modal
      wide
      busy={writing}
      title={<CodeTitle name={def.name} file={src?.path} state={!src ? null : !src.editable ? 'readonly' : dirty ? 'unsaved' : null} />}
      icon={<CodeBadge kind="component" />}
      onClose={requestClose}
      footer={
        src?.editable ? (
          <>
            <span className={`code-foot-note grow${justSaved ? ' saved' : ''}`} role="status">
              {busy ? <Spinner decorative /> : justSaved ? <CircleCheck aria-hidden="true" /> : null}
              <span>{note}</span>
            </span>
            {dirty && (
              <button className="btn" disabled={saving} onClick={() => void revert()}>
                Revert
              </button>
            )}
            <button className="btn" disabled={writing} onClick={requestClose}>
              Close
            </button>
            {/* While a save runs the button keeps focus (aria-disabled), so the keyboard is never dropped mid-save. */}
            <button className="btn btn-primary code-save" disabled={!dirty || blocked} aria-disabled={saving || undefined} onClick={requestSave} title={saveTitle(blocked ? 'Save' : action)} aria-keyshortcuts={SAVE_KEYS}>
              {saving ? busyLabel(status) : blocked ? 'Save' : action}
            </button>
          </>
        ) : (
          <>
            <span className="code-foot-note grow">
              <span>{src ? 'Generated from this component’s settings. To edit a copy of it, choose Convert to code in the Inspector.' : ''}</span>
            </span>
            <button className="btn" onClick={close}>
              Close
            </button>
          </>
        )
      }
    >
      <div className="code-dialog" ref={body}>
        <Tabs
          value={tab}
          onChange={setTab}
          label="Source views"
          idBase="source"
          keepMounted
          panelClassName="code-panel"
          options={[
            {
              value: 'source',
              label: 'Svelte source',
              extra: src?.editable ? <TabDot on={codeDirty} /> : undefined,
              panel: () =>
                src?.editable ? (
                  <CodeEditor
                    value={code}
                    onChange={changeCode}
                    locked={saving}
                    label={`${def.name} Svelte source`}
                    height="100%"
                    onSave={requestSave}
                    saveHint={saveHint}
                    onErrorCount={(n, line) => (setLiveErrors(n), setLiveLine(line))}
                    onChecking={setLiveChecking}
                    problemsShown={errors.some((p) => /^Line \d+:/.test(p))}
                    handle={editor}
                  />
                ) : src ? (
                  <CodeEditor value={src.source} readOnly label={`${def.name} Svelte source, read only`} height="100%" />
                ) : (
                  <SourceLoading failed={loadFailed && !loading} what="This component’s source" onRetry={() => setReload((n) => n + 1)} />
                )
            },
            {
              value: 'manifest',
              label: `Properties (${src?.editable ? rows.length : Object.keys(def.properties).length})`,
              extra: src?.editable ? <TabDot on={propsDirty} /> : undefined,
              panel: () =>
                src?.editable ? (
                  <div className="code-props" onKeyDown={keepDialogOnFieldEscape}>
                    <PropSchemaEditor rows={rows} onChange={changeRows} readOnly={saving} onTyping={setTyping} />
                  </div>
                ) : (
                  <pre className="code-view" tabIndex={0}>{JSON.stringify({ properties: def.properties, parts: def.parts, variants: Object.fromEntries(Object.entries(def.variantAxes ?? {}).map(([axis, a]) => [axis, Object.keys(a.options)])) }, null, 2)}</pre>
                )
            }
          ]}
        />
        {refreshFailed && (
          <div className="scope-note danger source-stale" role="alert">
            <CircleAlert aria-hidden="true" />
            <span className="grow">
              <strong>Couldn’t load the latest code.</strong> What you see may be out of date, so saving waits until it loads.{dirty ? ' Your edits stay.' : ''}
            </span>
            <button className="btn btn-sm" disabled={loading} onClick={() => setReload((n) => n + 1)}>
              {loading ? 'Loading…' : 'Try again'}
            </button>
          </div>
        )}
        {codeStale && (
          <div className="scope-note danger source-stale" role="alert">
            <CircleAlert aria-hidden="true" />
            <span className="grow">
              <strong>This code changed since you started editing it.</strong> The editor still shows your edits, and saving them would replace the newer version. If you use the newer code, Undo brings your edits back.
            </span>
            <button className="btn btn-sm" disabled={saving} onClick={takeNewerCode}>
              Use the newer code
            </button>
            <button className="btn btn-sm" disabled={saving} onClick={keepMyCode}>
              Keep my edits
            </button>
          </div>
        )}
        {propsStale && (
          <div className="scope-note danger source-stale props" role="alert">
            <CircleAlert aria-hidden="true" />
            <span className="grow">
              <strong>These properties changed since you started editing them.</strong> Saving your edits would replace{' '}
              {changedProps(JSON.parse(savedProps), def.properties)}. Reload to see the current properties; your source edits stay.
            </span>
            <button className="btn btn-sm" disabled={saving} onClick={reloadProps}>
              Reload properties
            </button>
          </div>
        )}
        <SaveProblems problems={errors} onGoTo={goToLine} focusRef={problemsList} />
        <span className="sr-only" role="status">
          {refusal(errors)}
        </span>
      </div>
    </Modal>
  );
}

/** The properties that differ between two schemas, for saying what a stale save would undo. */
function changedProps(was: Record<string, unknown>, now: Record<string, unknown>): string {
  const names = [...new Set([...Object.keys(was), ...Object.keys(now)])].filter((n) => JSON.stringify(was[n]) !== JSON.stringify(now[n]));
  if (!names.length) return 'the order they are listed in';
  const quoted = names.map((n) => `“${n}”`);
  return `the newer ${quoted.length === 1 ? quoted[0] : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`}`;
}

export function PageSourceModal({ pageId }: { pageId: string }) {
  const page = useStore((s) => s.snapshot?.state.pages[pageId]);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const editor = useRef<CodeEditorHandle | null>(null);
  const none = useRef<HTMLElement | null>(null);
  const alive = useAlive();
  useFocusKeeper(body, alive, none, () => editor.current?.focus());
  useEffect(() => {
    let current = true;
    // As in the component editor, a failure stands until a read succeeds.
    setLoading(true);
    api.project.generatedSource('page', pageId).then(
      (r) => current && (setSrc(r), setFailed(false), setLoading(false)),
      () => current && (setFailed(true), setLoading(false))
    );
    return () => {
      current = false;
    };
  }, [pageId, page, reload]);
  return (
    <Modal
      wide
      title={<CodeTitle name={page?.title ?? 'Page'} file={page ? pageFile(page) : undefined} state="readonly" />}
      icon={<CodeBadge kind="page" />}
      onClose={() => setState({ modal: null })}
      footer={
        <>
          <span className="code-foot-note grow">
            <span>Generated from this page’s content. To change it, edit the page on the canvas.</span>
          </span>
          <button className="btn" onClick={() => setState({ modal: null })}>
            Close
          </button>
        </>
      }
    >
      <div className="code-dialog" ref={body}>
        {src !== null ? (
          <CodeEditor value={src} readOnly label={`${page?.title ?? 'Page'} generated source, read only`} height="100%" handle={editor} />
        ) : (
          <SourceLoading failed={failed && !loading} what="This page’s source" onRetry={() => setReload((n) => n + 1)} />
        )}
        {failed && src !== null && (
          <div className="scope-note danger source-stale" role="alert">
            <CircleAlert aria-hidden="true" />
            <span className="grow">
              <strong>Couldn’t load the latest source.</strong> What you see may be out of date with the page.
            </span>
            <button className="btn btn-sm" disabled={loading} onClick={() => setReload((n) => n + 1)}>
              {loading ? 'Loading…' : 'Try again'}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}

export function NewCodeComponentModal() {
  const [name, setName] = useState('');
  const [source, setSource] = useState(CODE_STARTER);
  const [tab, setTab] = useState<'source' | 'manifest'>('source');
  // Never saved, so a changed name is a new name, not a rename.
  const [rows, setRows] = useState<SchemaRow[]>(() => rowsFromProperties(structuredClone(CODE_STARTER_PROPERTIES), false));
  const [initialProps] = useState(() => JSON.stringify(CODE_STARTER_PROPERTIES));
  const [errors, setErrors] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [writing, setWriting] = useState(false);
  const editor = useRef<CodeEditorHandle | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const problemsList = useRef<HTMLElement | null>(null);
  const discarding = useRef<Promise<boolean | null> | null>(null);
  const latest = useRef({ close: () => {}, create: () => {}, request: () => {} });
  useSaveKey(body, () => latest.current.request());
  const canFix = useStore((s) => !!s.providers.find((p) => p.id === s.settings?.ai.provider)?.configured);
  const [liveErrors, setLiveErrors] = useState(0);
  const [liveLine, setLiveLine] = useState<number | undefined>();
  const [liveChecking, setLiveChecking] = useState(true);
  const [checkedOk, setCheckedOk] = useState(false);
  const alive = useAlive();
  const tabNow = useRef(tab);
  tabNow.current = tab;
  useFocusKeeper(body, alive, problemsList, () => (tabNow.current === 'source' ? editor.current?.focus() : document.getElementById('new-code-tab-manifest')?.focus()));
  const sourceChanged = source !== CODE_STARTER;
  // Text still being typed in a property field is a change too, before the field commits.
  const [typing, setTyping] = useState(false);
  const propsChanged = typing || hiddenEdits(rows) || JSON.stringify(propertiesFromRows(rows)) !== initialProps;
  const unsaved = sourceChanged || !!name.trim() || propsChanged;
  // Leaving the project (closing the window, quitting) asks about it too.
  useEffect(() => {
    markDraft(CODE_DRAFT, unsaved);
    return () => markDraft(CODE_DRAFT, false);
  }, [unsaved]);
  // Every way out (×, Escape, backdrop, Cancel) goes through here, so unsaved code is never dropped silently.
  const close = () => {
    if (writing || discarding.current) return;
    if (!unsaved) return void setState({ modal: null });
    const asked = confirmDialog({
      title: 'Discard this new component?',
      body: 'The editor closes and the component is never created.',
      subject: name.trim() || undefined,
      subjectKind: 'component',
      details: [{ kind: 'final', text: 'Your unsaved work on this component can’t be brought back.' }],
      confirmLabel: 'Discard',
      cancelLabel: 'Keep editing',
      tone: 'caution',
      icon: 'discard'
    });
    discarding.current = asked;
    void asked.then((ok) => {
      discarding.current = null;
      if (ok === true) setState({ modal: null });
    });
  };
  const requestClose = () => (commitField() ? void setTimeout(() => latest.current.close()) : close());
  const goToLine = (line: number) => {
    setTab('source');
    setTimeout(() => editor.current?.goTo(line));
  };
  const create = async () => {
    if (saving) return;
    const title = name.trim();
    if (!title) return nameInput.current?.focus();
    setErrors([]);
    if (schemaProblems(rows).length) return showPropertyProblems(setTab);
    let wrote = false;
    setSaving(true);
    try {
      const checked = await prepareCodeForSave(source, setStatus, alive);
      if (!checked.ok) return setErrors(checked.problems);
      while (discarding.current) if ((await discarding.current) === true) return;
      if (!alive()) return;
      wrote = true;
      setWriting(true);
      const r = await applyOps([{ type: 'component.createCode', name: title, source: checked.source, properties: propertiesFromRows(rows) }], `Create ${title}`);
      const id = r?.[0]?.definitionId as string | undefined;
      if (!id) return setErrors([CREATE_FAILED]);
      if (checked.fixed) toast(`Fixed and created: ${checked.fixed}`);
      setState({ modal: null });
      await insert({ definitionId: id }, title);
    } catch {
      setErrors([wrote ? CREATE_FAILED : CREATE_CHECK_FAILED]);
    } finally {
      setStatus(null);
      setWriting(false);
      setSaving(false);
    }
  };
  const settledErrors = liveChecking ? 0 : liveErrors;
  // Reviewing needs a name too: until there is one, the action is to name the component.
  const reviewing = !!name.trim() && settledErrors > 0 && !canFix;
  const listed = errors.some((p) => !isAdvice(p));
  const propIssues = !typing ? schemaProblems(rows).length : 0;
  const blocked = (reviewing && listed) || propIssues > 0;
  const reviewErrors = () => {
    if (saving) return;
    const line = firstLine(errors);
    if (line) return goToLine(line);
    void reviewCode(source, alive, { setBusy: setSaving, setStatus, setErrors, clearLive: () => (setLiveErrors(0), setCheckedOk(true)) });
  };
  const requestCreate = () => {
    if (blocked) return;
    if (reviewing && !editor.current?.checking()) return reviewErrors();
    const field = commitField();
    if (!field) return void create();
    setTimeout(() => {
      latest.current.create();
      field.focus();
    });
  };
  latest.current = { close, create: () => void create(), request: requestCreate };
  const busy = !!status || writing;
  const footNote = () => {
    if (status) return tidy(status);
    if (writing) return 'Creating…';
    if (!name.trim()) return 'Name this component to create it.';
    if (propIssues) return propertyNote(propIssues, tab === 'manifest', 'create it');
    if (blocked) return `Fix ${count(settledErrors, 'error')} listed above, then create it.`;
    if (listed) return 'Fix what is listed above, then try again.';
    if (checkedOk) return 'Your code passed the check. Create it to add it to the page.';
    if (reviewing) return `Fix ${count(settledErrors, 'error')}${liveLine && settledErrors === 1 ? ` on line ${liveLine}` : ''} to create it.`;
    if (settledErrors && canFix) return 'Errors are repaired automatically before this is added to the page.';
    return 'Your code is checked before it is added to the page.';
  };
  const note = footNote();
  const action = reviewing ? 'Review errors' : 'Create and insert';
  const saveHint = !name.trim() || blocked ? null : reviewing ? 'reviews errors' : settledErrors && canFix ? 'fixes errors and creates it' : 'creates it';
  return (
    <Modal
      wide
      busy={writing}
      title={<CodeTitle name="New code component" state={unsaved ? 'draft' : null} />}
      icon={<CodeBadge kind="component" />}
      onClose={requestClose}
      footer={
        <>
          <span className="code-foot-note grow" role="status">
            {busy && <Spinner decorative />}
            <span>{note}</span>
          </span>
          <button className="btn" disabled={writing} onClick={requestClose}>
            Cancel
          </button>
          <button className="btn btn-primary code-save" disabled={!name.trim() || blocked} aria-disabled={saving || undefined} onClick={requestCreate} title={saveTitle(blocked ? 'Create and insert' : action)} aria-keyshortcuts={SAVE_KEYS}>
            {saving ? busyLabel(status, 'Creating…') : blocked ? 'Create and insert' : action}
          </button>
        </>
      }
    >
      <div className="code-dialog" ref={body}>
        <div className="code-name">
          <Field label="Name">
            <input ref={nameInput} className="input" autoFocus aria-required="true" value={name} readOnly={saving} onChange={(e) => setName(e.target.value)} placeholder="Booking widget" />
          </Field>
        </div>
        <Tabs
          value={tab}
          onChange={setTab}
          label="New component views"
          idBase="new-code"
          keepMounted
          panelClassName="code-panel"
          options={[
            {
              value: 'source',
              label: 'Svelte source',
              extra: <TabDot on={sourceChanged} />,
              panel: () => (
                <CodeEditor
                  value={source}
                  onChange={(v) => {
                    setSource(v);
                    setCheckedOk(false);
                    setErrors((e) => (e.length ? [] : e));
                  }}
                  locked={saving}
                  label="New component Svelte source"
                  height="100%"
                  onSave={requestCreate}
                  saveHint={saveHint}
                  onErrorCount={(n, line) => (setLiveErrors(n), setLiveLine(line))}
                  onChecking={setLiveChecking}
                  problemsShown={errors.some((p) => /^Line \d+:/.test(p))}
                  handle={editor}
                />
              )
            },
            {
              value: 'manifest',
              label: `Properties (${rows.length})`,
              extra: <TabDot on={propsChanged} />,
              panel: () => (
                <div className="code-props" onKeyDown={keepDialogOnFieldEscape}>
                  <PropSchemaEditor
                    rows={rows}
                    onChange={(next) => {
                      setRows(next);
                      setErrors((e) => (e.length ? [] : e));
                    }}
                    readOnly={saving}
                    onTyping={setTyping}
                  />
                </div>
              )
            }
          ]}
        />
        <SaveProblems problems={errors} onGoTo={goToLine} focusRef={problemsList} heading="Not created" />
        <span className="sr-only" role="status">
          {refusal(errors, 'Not created')}
        </span>
      </div>
    </Modal>
  );
}
