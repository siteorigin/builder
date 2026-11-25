/**
 * What a run's record must show to count as the principal journey (issue #498): from a fresh Welcome, a site created,
 * its content edited and found saved, a question asked in Ask mode and its answer read, an edit requested, the
 * assistant's request to change more decided, the preview looked at, an Undo and then a Redo, and the website exported
 * and its files read back. It reads only the session's own record (replay.json): what was sent to the app, at which
 * target, and how each step ended. Never what a client says it did.
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
/** The element an input went to: the search that found it, else what the reply said it reached. */
function target(e: JournalEntry): { role?: string; name?: string } {
  const t = e.targets?.find((d) => d.at === 'target') ?? e.targets?.[0];
  const reached = summary(e).target as { role?: string; name?: string } | undefined;
  return { role: t?.role ?? reached?.role, name: t?.name ?? reached?.name };
}
const named = (e: JournalEntry, role: string | RegExp, name: RegExp) => {
  const t = target(e);
  return (typeof role === 'string' ? t.role === role : role.test(t.role ?? '')) && name.test(t.name ?? '');
};
const key = (e: JournalEntry) => (e.op === 'ui.press' && typeof e.args?.key === 'string' ? e.args.key : '');
const menuPath = (e: JournalEntry) => (e.op === 'menu.invoke' && Array.isArray(e.args?.path) ? (e.args.path as string[]).join(' > ') : '');
const arg = (e: JournalEntry, k: string) => (typeof e.args?.[k] === 'string' ? (e.args[k] as string) : '');
/** Fields a message or an answer is typed into, which are not the site's content. */
const CHAT_FIELDS = /^(Message|Your answer)$/;

/** A message sent from the chat's composer: Enter in it, or its Send button. */
function sendsMessage(e: JournalEntry): boolean {
  if (!sent(e)) return false;
  if (e.op === 'ui.press' && key(e) === 'Enter') return /^Message$/.test(target(e).name ?? '');
  return e.op === 'ui.click' && named(e, 'button', /^Send\b/);
}

const isUndo = (e: JournalEntry) =>
  sent(e) && ((e.op === 'ui.click' && named(e, /^(button|menuitem)$/, /^Undo\b/)) || /^(ControlOrMeta|Meta|Control)\+z$/i.test(key(e)) || menuPath(e) === 'Edit > Undo');
const isRedo = (e: JournalEntry) =>
  sent(e) &&
  ((e.op === 'ui.click' && named(e, /^(button|menuitem)$/, /^Redo\b/)) || /^(ControlOrMeta|Meta|Control)\+Shift\+z$/i.test(key(e)) || /^(ControlOrMeta|Control)\+y$/i.test(key(e)) || menuPath(e) === 'Edit > Redo');

export function proveJourney(record: JourneyRecord): JourneyProof {
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

  const fresh = record.scenario.fixture === 'welcome' && record.complete;
  witnesses.push({ id: 'fresh', what: 'a fresh session at Welcome, recorded from its start', seq: fresh ? 0 : null, ...(fresh ? {} : { missing: record.complete ? `it started with the ${record.scenario.fixture} fixture` : 'the record lost its first steps' }) });
  const start = fresh ? 0 : null;

  const created = find('created', 'a new project created from its dialog', start, (e) => sent(e) && e.op === 'ui.click' && named(e, 'button', /^Create project$/), 'no click on Create project');
  // The edit: text typed into the site (not a chat message or the project's name) after it was created, then found in
  // its documents on disk by project.summary.
  const intoSite = (t: JournalEntry) => created !== null && t.seq > created && sent(t) && (t.op === 'ui.fill' || t.op === 'ui.type') && !!arg(t, 'text') && !CHAT_FIELDS.test(target(t).name ?? '') && target(t).name !== 'Project name';
  find(
    'edited',
    'content edited, and found saved in the project',
    created,
    (e) => looked(e) && e.op === 'project.summary' && !!arg(e, 'find') && (summary(e).found as number) > 0 && steps.some((t) => t.seq < e.seq && intoSite(t) && arg(t, 'text').includes(arg(e, 'find'))),
    'no project.summary found text that was typed into the site after it was created'
  );

  const askMode = find('ask-mode', 'Ask chosen for the next message', created, (e) => sent(e) && e.op === 'ui.click' && named(e, 'menuitemradio', /^Ask\b/), 'Ask was never chosen in the chat');
  const asked = find('asked', 'a question sent to the assistant', askMode, sendsMessage, 'no message was sent after Ask was chosen');
  find(
    'answer',
    'the answer read',
    asked,
    (e) => looked(e) && (e.op === 'assistant.wait' || e.op === 'assistant.observe' || ((e.op === 'wait.for' || e.op === 'ui.waitFor' || e.op === 'ui.locate') && /Answered/.test(arg(e, 'name')))),
    'nothing read the assistant\'s reply after the question'
  );
  const editMode = find('edit-mode', 'Edit chosen for the next message', asked, (e) => sent(e) && e.op === 'ui.click' && named(e, 'menuitemradio', /^Edit\b/), 'Edit was not chosen again after the question');
  const requested = find('requested', 'an edit requested', editMode, sendsMessage, 'no message was sent after Edit was chosen');
  const decided = find('decided', 'the request to change more answered', requested, (e) => sent(e) && e.op === 'ui.click' && named(e, 'button', /allow changes|only change the selection/i), 'the assistant\'s request to change more was never answered');
  find(
    'preview',
    'the preview looked at',
    decided,
    (e) => looked(e) && (e.op === 'ui.snapshot' || (['ui.locate', 'ui.waitFor', 'wait.for'].includes(e.op) && (arg(e, 'scope') === 'preview' || arg(e, 'condition') === 'preview.ready'))),
    'nothing looked at the preview after the decision'
  );
  const undone = find('undo', 'an Undo', decided, isUndo, 'no Undo after the decision');
  find('redo', 'a Redo after it', undone, isRedo, 'no Redo after the Undo');
  const exported = find('exported', 'the website exported', created, (e) => looked(e) && e.op === 'wait.for' && arg(e, 'condition') === 'export.finished' && summary(e).outcome === 'exported', 'no export finished as exported');
  find('export-read', 'the exported files read back and found holding the site', exported, (e) => looked(e) && e.op === 'exports.inspect' && (summary(e).found as number) > 0, 'no exports.inspect found text in the export');
  return { ok: witnesses.every((w) => w.seq !== null), witnesses };
}

/** One line per witness, for a report. */
export function describeProof(p: JourneyProof): string {
  return p.witnesses.map((w) => `${w.seq === null ? '✗' : '✓'} ${w.what}${w.seq === null ? `: ${w.missing}` : ` (step ${w.seq})`}`).join('\n');
}
