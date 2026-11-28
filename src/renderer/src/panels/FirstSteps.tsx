import './FirstSteps.css';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
import { FIRST_STEPS, firstStepsDone, headingTarget, type FirstStepId, type FirstStepsRecord } from '@shared/first-steps';
import { getState, saveLocal, setState, toast, useStore } from '../store';
import { openSection } from '../components/ui';
import { openSiteStyles, selectPage, setMode } from '../lib/actions';
import { openEditorDestination } from '../lib/open-destination';
import { activeWorkspace, canvasCovered } from '../lib/workspace';
import { platformKeys } from './CopyPaste';

/**
 * Get started (#951): a new Business site opens with a short list, under its pages, of what a first-time author does
 * first. Each step is a button that takes the author to where it is done, and is ticked once the project has it
 * (shared/first-steps), never by hand. The list folds to its heading, and Hide puts it away for good: in this project,
 * and for the projects made after it. It is not a tour: nothing points at the editor or waits on the author.
 */

const STEPS: Record<FirstStepId, { title: string; hint: string }> = {
  heading: { title: 'Rewrite the main heading', hint: 'Opens the home page heading in the Inspector, ready to type.' },
  style: { title: 'Change name or colors', hint: 'Opens Site styles at Brand color. The site name is under Site.' },
  page: { title: 'Add a page', hint: 'Opens Add page at the top of this list.' },
  preview: { title: 'Preview your site', hint: 'Shows the site as visitors see it, with working links.' },
  export: { title: 'Export your website', hint: 'Opens Export. Choose Website for the files your web host needs.' }
};
/** The heading step when the home page has no section with a heading to rewrite. */
const NO_HEADING_HINT = 'Opens the home page, to add a section with a heading.';

/** Change this project's record, in the editor and its workspace file. */
function update(patch: Partial<FirstStepsRecord>) {
  const now = getState().firstSteps;
  if (!now) return;
  const next = { ...now, ...patch };
  setState({ firstSteps: next });
  saveLocal({ firstSteps: next });
}

function go(id: FirstStepId) {
  const s = getState();
  const snap = s.snapshot;
  if (!snap || !s.firstSteps) return;
  if (id === 'heading') {
    const h = headingTarget(snap.state);
    if (h) return openEditorDestination({ kind: 'prop', owner: { kind: 'page', id: h.pageId }, nodeId: h.nodeId, prop: h.prop });
    // No section on the home page has a heading now: the page opens, to add one.
    if (s.mode !== 'edit') setMode('edit');
    return selectPage(snap.state.site.homePageId, null);
  }
  if (id === 'style') {
    // Basics shows, with Site details open below it, so both halves of the step are a glance apart.
    openSiteStyles();
    requestAnimationFrame(() => {
      openSection('site-settings', { scroll: false });
      openSection('tok-basics', { focus: '[data-color-pick] input' });
    });
    return;
  }
  if (id === 'page') {
    if (s.mode !== 'edit') setMode('edit');
    return void window.dispatchEvent(new Event('builder-add-page'));
  }
  if (id === 'preview') return setMode('preview');
  setState({ modal: { kind: 'export' } });
}

/**
 * Notes what the project's own content cannot show: that the author has seen the site in Preview, once its preview is
 * ready (not a loading or failed one), and that a website export finished (an export of the editable project still has
 * to be built, so it is not the step). Mounted with the editor, so neither is missed while the list is folded or the
 * sidebar shows another view.
 */
export function useFirstStepsTracking() {
  useEffect(
    () =>
      useStore.subscribe((s) => {
        const r = s.firstSteps;
        // Recorded while hidden too, since Show Get started can bring the list back.
        if (!r) return;
        if (!r.previewed && s.mode === 'preview' && s.runtime?.state === 'ready' && s.frameReady && !canvasCovered(activeWorkspace(s))) update({ previewed: true });
        if (!r.exported && s.snapshot?.recentExports.some((e) => e.kind === 'site')) update({ exported: true });
      }),
    []
  );
}

/** Show Get started again (the command menu): here, and for the projects made after this one. */
export function showGetStarted() {
  update({ hidden: false, folded: false });
  setState({ leftTab: 'pages' });
}

/**
 * Says each step that changes, once, as it happens, done or undone again (an Undo), wherever the author is: it is
 * mounted with the editor, never inside the sidebar view, which is hidden while another view shows. Quiet for the
 * steps a project opens with, and once the list is hidden.
 */
export function GetStartedStatus() {
  const record = useStore((s) => s.firstSteps);
  const state = useStore((s) => s.snapshot?.state);
  const opening = useStore((s) => s.snapshot?.workspaceKey);
  const done = record && !record.hidden && state ? firstStepsDone(state, record) : null;
  const [said, setSaid] = useState('');
  const last = useRef<{ opening?: string; done: Record<FirstStepId, boolean> } | null>(null);
  const key = done ? FIRST_STEPS.map((id) => (done[id] ? 1 : 0)).join('') : '';
  useEffect(() => {
    const was = last.current;
    last.current = done ? { opening, done } : null;
    // A new opening, or the list hidden: what was said before is cleared, so the next change is heard even if it reads
    // the same.
    if (!done || !was || was.opening !== opening) return setSaid('');
    const changed = FIRST_STEPS.find((id) => done[id] !== was.done[id]);
    if (!changed) return;
    const count = FIRST_STEPS.filter((id) => done[id]).length;
    setSaid(count === FIRST_STEPS.length ? 'Get started: all five steps done.' : `${done[changed] ? 'Done' : 'Not done any more'}: ${STEPS[changed].title}. ${count} of ${FIRST_STEPS.length} steps done.`);
  }, [key, opening]);
  return (
    <span className="sr-only" role="status" aria-atomic="true">
      {said}
    </span>
  );
}

export function FirstSteps() {
  const record = useStore((s) => s.firstSteps);
  const state = useStore((s) => s.snapshot?.state);
  const listId = useId();
  const done = record && state ? firstStepsDone(state, record) : null;
  const count = done ? FIRST_STEPS.filter((id) => done[id]).length : 0;
  const allDone = !!done && FIRST_STEPS.every((id) => done[id]);
  const closeRef = useRef<HTMLButtonElement>(null);
  // The step that finished the list (Preview, pressed from the keyboard) goes with the list: focus lands on Hide this
  // list rather than on nothing. Focus anywhere else (the Inspector, Site styles, Export) stays where it is.
  useLayoutEffect(() => {
    if (!allDone || (document.activeElement && document.activeElement !== document.body)) return;
    closeRef.current?.focus({ preventScroll: true });
    // In a short sidebar the card's body scrolls: the button is brought into it, the sidebar itself left where it is.
    closeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [allDone]);
  if (!record || record.hidden || !done) return null;
  const folded = !!record.folded;
  const next = FIRST_STEPS.find((id) => !done[id]);
  const all = !next;

  const hide = () => {
    update({ hidden: true });
    // Focus goes to the Pages button, so it is not lost with the list.
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.rail [aria-label="Pages"]')?.focus());
    const opening = getState().snapshot?.workspaceKey;
    toast(`Get started is hidden here and in new projects. Show it again from the command menu (${platformKeys('⌘K')}).`, 'info', { label: 'Undo', opening, run: () => update({ hidden: false }) });
  };

  return (
    <section className={`get-started${folded ? ' folded' : ''}${all ? ' all-done' : ''}`} aria-labelledby={`${listId}-title`}>
      <div className="get-started-head">
        <button type="button" className="get-started-toggle" aria-expanded={!folded} aria-controls={`${listId}-body`} onClick={() => update({ folded: !folded })}>
          {folded ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
          <span id={`${listId}-title`} className="get-started-title">
            {all ? 'All set' : 'Get started'}
          </span>
          <span className="get-started-count">
            {count} of {FIRST_STEPS.length}
          </span>
        </button>
        {(!all || folded) && (
          <button type="button" className="btn btn-ghost btn-sm get-started-hide" title={`Hide here and in new projects. To bring it back, open the command menu (${platformKeys('⌘K')}) and choose Show Get started.`} onClick={hide}>
            Hide
          </button>
        )}
      </div>
      <div className="get-started-meter" aria-hidden="true">
        <span style={{ width: `${(count / FIRST_STEPS.length) * 100}%` }} />
      </div>
      <div id={`${listId}-body`} className="get-started-body" hidden={folded}>
        {all ? (
          <div className="get-started-done">
            <p>You’ve done all five steps, including a website export. Hiding this list also hides it in new projects.</p>
            <button ref={closeRef} type="button" className="btn btn-sm get-started-close" onClick={hide}>
              Hide this list
            </button>
          </div>
        ) : (
          <ol className="get-started-list">
            {FIRST_STEPS.map((id) => {
              const isDone = done[id];
              const isNext = id === next;
              return (
                <li key={id}>
                  <button
                    type="button"
                    className={`gs-step${isDone ? ' done' : ''}${isNext ? ' next' : ''}`}
                    onClick={() => go(id)}
                    aria-labelledby={`${listId}-${id}`}
                    aria-describedby={isNext ? `${listId}-${id}-hint` : undefined}
                  >
                    <span className="gs-step-mark" aria-hidden="true">
                      {isDone && <Check />}
                    </span>
                    <span className="gs-step-text">
                      <span id={`${listId}-${id}`} className="gs-step-title">
                        {isDone && <span className="sr-only">Done: </span>}
                        {STEPS[id].title}
                      </span>
                      {isNext && (
                        <span id={`${listId}-${id}-hint`} className="gs-step-hint">
                          {id === 'heading' && !headingTarget(state!) ? NO_HEADING_HINT : STEPS[id].hint}
                        </span>
                      )}
                    </span>
                    <ChevronRight className="gs-step-go" aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
