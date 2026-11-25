/**
 * What a run's record must show to count as the principal journey (issue #498): from a fresh Welcome with the scripted
 * assistant, a site created; its content edited to an expected text and that text found saved; a question asked in Ask
 * mode and its answer read; an edit requested in Edit mode; the assistant's request to change more allowed, and the site
 * seen under its new name; an Undo that puts the old name back and a Redo that brings the new one again; the preview
 * looked at; then the website exported and that export's files read back holding the edit.
 *
 * It reads only the session's own record (replay.json): what was sent, to which element (as the app reported reaching
 * it), and how each step ended, with the facts the session keeps from each reply. Never what a client says it did. The
 * expected values (the edited text, the site's names) are the caller's, so a record cannot pass on what the starter
 * already held, or on an Undo that changed only text being typed.
 *
 * The Node journey (tests/e2e/journeys.mjs) and the model-driven smoke test (scripts/model-smoke.mjs) are both held to
 * it, so the external model is judged by the same rules as the deterministic replay.
 */
import type { JournalEntry } from '../driver/evidence.ts';

/** The part of a replay record the proof reads. */
export interface JourneyRecord {
  scenario: { fixture: string; provider: string };
  complete: boolean;
  steps: JournalEntry[];
}

/** What the journey is expected to have done. */
export interface JourneyExpectations {
  /** The text the site's content was edited to (not text the starter already has). */
  edit: string;
  /** The site's name before the assistant renamed it, and after. */
  oldName: string;
  newName: string;
  /** The assistant's answer to the question, when the caller scripted it. */
  answer?: string;
}

export interface Witness {
  id: string;
  /** What it stands for. */
  what: string;
  /** The step that shows it, or null when none does. */
  seq: number | null;
  /** Why none does. */
  missing?: string;
}

export interface JourneyProof {
  ok: boolean;
  witnesses: Witness[];
}

const sent = (e: JournalEntry) => e.class === 'input' && e.outcome?.ok === true;
const looked = (e: JournalEntry) => e.class === 'observation' && e.outcome?.ok === true;
const summary = (e: JournalEntry) => (e.outcome?.summary ?? {}) as Record<string, unknown>;
/** The element an input went to: what the app reported reaching, else the search that found it. */
function target(e: JournalEntry): { role?: string; name?: string } {
  const reached = summary(e).target as { role?: string; name?: string } | undefined;
  const t = e.targets?.find((d) => d.at === 'target') ?? e.targets?.[0];
  return { role: reached?.role ?? t?.role, name: reached?.name ?? t?.name };
}
const reaches = (e: JournalEntry, role: string | RegExp, name: RegExp) => {
  const t = target(e);
  return (typeof role === 'string' ? t.role === role : role.test(t.role ?? '')) && name.test(t.name ?? '');
};
const key = (e: JournalEntry) => (e.op === 'ui.press' && typeof e.args?.key === 'string' ? e.args.key : '');
const menuPath = (e: JournalEntry) => (e.op === 'menu.invoke' && Array.isArray(e.args?.path) ? (e.args.path as string[]).join(' > ') : '');
const arg = (e: JournalEntry, k: string) => (typeof e.args?.[k] === 'string' ? (e.args[k] as string) : '');
/** Fields a message or an answer is typed into, which are not the site's content. */
const CHAT_FIELDS = /^(Message|Your answer)$/;

/** A click on the control, or a key that activates it once it has the focus. */
const activates = (e: JournalEntry, role: string, name: RegExp) => sent(e) && (e.op === 'ui.click' || ['Enter', ' ', 'Space'].includes(key(e))) && reaches(e, role, name);

/** A message sent from the chat's composer: Enter in it, or its Send button. */
function sendsMessage(e: JournalEntry): boolean {
  if (!sent(e)) return false;
  if (e.op === 'ui.press' && key(e) === 'Enter') return reaches(e, 'textbox', /^Message$/);
  return e.op === 'ui.click' && reaches(e, 'button', /^Send\b/);
}

const isUndo = (e: JournalEntry) =>
  sent(e) && ((e.op === 'ui.click' && reaches(e, /^(button|menuitem)$/, /^Undo\b/)) || /^(ControlOrMeta|Meta|Control)\+z$/i.test(key(e)) || menuPath(e) === 'Edit > Undo');
const isRedo = (e: JournalEntry) =>
  sent(e) &&
  ((e.op === 'ui.click' && reaches(e, /^(button|menuitem)$/, /^Redo\b/)) || /^(ControlOrMeta|Meta|Control)\+Shift\+z$/i.test(key(e)) || /^(ControlOrMeta|Control)\+y$/i.test(key(e)) || menuPath(e) === 'Edit > Redo');

/** A look that found the site under `name`: its brand in the preview by that name, or the project's documents. */
function showsName(e: JournalEntry, name: string): boolean {
  if (!looked(e)) return false;
  if (e.op === 'project.summary') return summary(e).site === name;
  if (!['ui.locate', 'ui.waitFor', 'wait.for'].includes(e.op) || arg(e, 'scope') !== 'preview') return false;
  if (e.op === 'wait.for' && arg(e, 'condition') !== 'ui.present') return false;
  return arg(e, 'name') === name || summary(e).name === name;
}

/** A look at the preview: a snapshot that takes it in, a search in it, or a wait for it to be ready. */
const looksAtPreview = (e: JournalEntry) =>
  looked(e) && ((e.op === 'ui.snapshot' && arg(e, 'scope') !== 'editor') || (['ui.locate', 'ui.waitFor', 'wait.for'].includes(e.op) && arg(e, 'scope') === 'preview') || (e.op === 'wait.for' && arg(e, 'condition') === 'preview.ready'));

export function proveJourney(record: JourneyRecord, expect: JourneyExpectations): JourneyProof {
  const steps = [...record.steps].sort((a, b) => a.seq - b.seq);
  const witnesses: Witness[] = [];
  /** The first step after `after` that fits, recorded as a witness. */
  const find = (id: string, what: string, after: number | null, fits: (e: JournalEntry) => boolean, missing: string): number | null => {
    if (after === null) {
      witnesses.push({ id, what, seq: null, missing: 'an earlier step is missing' });
      return null;
    }
    const hit = steps.find((e) => e.seq > after && fits(e));
    witnesses.push({ id, what, seq: hit?.seq ?? null, ...(hit ? {} : { missing }) });
    return hit?.seq ?? null;
  };

  const fresh = record.scenario.fixture === 'welcome' && record.scenario.provider === 'scripted' && record.complete;
  const why = !record.complete ? 'the record lost its first steps' : record.scenario.fixture !== 'welcome' ? `it started with the ${record.scenario.fixture} fixture` : `its assistant was ${record.scenario.provider}, not scripted`;
  witnesses.push({ id: 'fresh', what: 'a fresh session at Welcome with the scripted assistant, recorded from its start', seq: fresh ? 0 : null, ...(fresh ? {} : { missing: why }) });
  const start = fresh ? 0 : null;

  const created = find(
    'created',
    'a new project created from its dialog',
    start,
    (e) => (sent(e) && e.op === 'ui.click' && reaches(e, 'button', /^Create project$/)) || (sent(e) && key(e) === 'Enter' && reaches(e, 'textbox', /^Project name$/)),
    'neither Create project nor Enter in Project name created a project'
  );
  // The edit: the expected text typed into the site (not a chat message or the project's name) after it was created,
  // then found in its documents on disk by project.summary.
  const typedEdit = (t: JournalEntry) => created !== null && t.seq > created && sent(t) && (t.op === 'ui.fill' || t.op === 'ui.type') && arg(t, 'text').includes(expect.edit) && !CHAT_FIELDS.test(target(t).name ?? '') && target(t).name !== 'Project name';
  const edited = find(
    'edited',
    `content edited to “${expect.edit}”, and found saved in the project`,
    created,
    (e) => looked(e) && e.op === 'project.summary' && arg(e, 'find') === expect.edit && (summary(e).found as number) > 0 && steps.some((t) => t.seq < e.seq && typedEdit(t)),
    `no project.summary found “${expect.edit}” after it was typed into the site`
  );

  const askMode = find('ask-mode', 'Ask chosen for the next message', edited, (e) => activates(e, 'menuitemradio', /^Ask\b/), 'Ask was never chosen in the chat after the edit');
  const asked = find('asked', 'a question sent to the assistant', askMode, sendsMessage, 'no message was sent after Ask was chosen');
  find(
    'answer',
    'the answer read',
    asked,
    (e) => {
      if (!looked(e)) return false;
      if (e.op === 'assistant.wait') {
        const s = summary(e);
        return s.reason === 'terminal' && s.ask === true && (expect.answer === undefined ? typeof s.text === 'string' && !!s.text : s.text === expect.answer);
      }
      return ['wait.for', 'ui.waitFor', 'ui.locate'].includes(e.op) && /^Answered · site unchanged/.test(arg(e, 'name'));
    },
    expect.answer === undefined ? 'no wait saw the question answered' : `no wait saw the question answered with “${expect.answer}”`
  );
  const editMode = find('edit-mode', 'Edit chosen for the next message', asked, (e) => activates(e, 'menuitemradio', /^Edit\b/), 'Edit was not chosen again after the question');
  const requested = find('requested', 'an edit requested', editMode, sendsMessage, 'no message was sent after Edit was chosen');
  const decided = find('decided', 'the assistant allowed to change more than the selection', requested, (e) => sent(e) && e.op === 'ui.click' && reaches(e, 'button', /^Yes, allow changes\b/), 'the assistant\'s request to change more was never allowed');
  const renamed = find('renamed', `the site seen renamed to “${expect.newName}”`, decided, (e) => showsName(e, expect.newName), `nothing showed the site as “${expect.newName}” after it was allowed`);
  find('preview', 'the preview looked at', decided, looksAtPreview, 'nothing looked at the preview after the decision');
  const undo = find('undo', 'an Undo', renamed, isUndo, 'no Undo after the rename was seen');
  const undone = find('undone', `the old name “${expect.oldName}” seen back`, undo, (e) => showsName(e, expect.oldName), `nothing showed “${expect.oldName}” again after the Undo`);
  const redo = find('redo', 'a Redo', undone, isRedo, 'no Redo after the Undo was seen');
  const redone = find('redone', `“${expect.newName}” seen again`, redo, (e) => showsName(e, expect.newName), `nothing showed “${expect.newName}” again after the Redo`);
  const exported = find('exported', 'the website exported after all of it', redone, (e) => looked(e) && e.op === 'wait.for' && arg(e, 'condition') === 'export.finished' && summary(e).outcome === 'exported', 'no export finished as exported after the Redo');
  const folder = exported === null ? undefined : (summary(steps.find((e) => e.seq === exported)!).export as string | undefined);
  find(
    'export-read',
    `that export's files read back holding “${expect.edit}”`,
    exported,
    (e) => looked(e) && e.op === 'exports.inspect' && arg(e, 'find') === expect.edit && (summary(e).found as number) > 0 && (!folder || arg(e, 'path') === folder),
    `no exports.inspect of ${folder ?? 'the export'} found “${expect.edit}”`
  );
  return { ok: witnesses.every((w) => w.seq !== null), witnesses };
}

/** One line per witness, for a report. */
export function describeProof(p: JourneyProof): string {
  return p.witnesses.map((w) => `${w.seq === null ? '✗' : '✓'} ${w.what}${w.seq === null ? `: ${w.missing}` : ` (step ${w.seq})`}`).join('\n');
}
