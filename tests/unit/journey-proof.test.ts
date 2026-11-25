import { describe, expect, it } from 'vitest';
import type { JournalEntry } from '../driver/evidence';
import { describeProof, forbiddenSteps, proveJourney } from '../coverage/journey-proof';
import type { JourneyRecord } from '../coverage/journey-proof';

type Step = Omit<JournalEntry, 'seq' | 'id' | 't' | 'window'>;
/** An input, with the element the app reported reaching. */
const input = (op: string, args: Record<string, unknown>, role?: string, name?: string): Step => ({
  op,
  class: 'input',
  args,
  ...(role ? { targets: [{ at: 'target', role, name, replayable: true }] } : {}),
  outcome: { ok: true, summary: { dispatched: 'complete', ...(role ? { target: { surface: 'editor', role, name } } : {}) } }
});
const click = (role: string, name: string) => input('ui.click', { target: { ref: 'e1' } }, role, name);
const look = (op: string, args: Record<string, unknown>, summary: Record<string, unknown> = {}): Step => ({ op, class: 'observation', args, outcome: { ok: true, summary } });
const press = (key: string, role?: string, name?: string): Step => ({ op: 'ui.press', class: 'input', args: { key }, outcome: { ok: true, summary: { dispatched: 'complete', ...(role ? { target: { surface: 'editor', role, name } } : {}) } } });
/** Enter sent to the composer that has the focus: the driver reports it by tag and name, with no role. */
const enter: Step = { op: 'ui.press', class: 'input', args: { key: 'Enter' }, outcome: { ok: true, summary: { dispatched: 'complete', target: { surface: 'editor', name: 'Message', tag: 'textarea' } } } };
const inPreview = (name: string) => look('wait.for', { condition: 'ui.present', role: 'link', name, scope: 'preview' }, { condition: 'ui.present', met: true });

const EXPECT = { edit: 'Harbour light in every season', oldName: 'Harbour Lane Studio', newName: 'Quayside Rooms', answer: 'It says the heading.' };
const ALLOW = 'Yes, allow changes across the whole site';

/** The principal journey as the Node test records it. */
const JOURNEY: Step[] = [
  look('ui.snapshot', {}),
  click('button', 'New project'),
  input('ui.fill', { target: { ref: 'e2' }, text: EXPECT.oldName }, 'textbox', 'Project name'),
  click('button', 'Create project'),
  look('wait.for', { condition: 'preview.ready', path: '/' }, { condition: 'preview.ready', met: true }),
  input('ui.fill', { target: { ref: 'e3' }, text: EXPECT.edit }, 'textbox', 'Heading'),
  look('wait.for', { condition: 'save.settled' }),
  look('project.summary', { find: EXPECT.edit }, { revision: 4, site: EXPECT.oldName, found: 1, complete: true }),
  click('menuitemradio', 'Ask, a read-only question'),
  input('ui.fill', { target: { ref: 'e4' }, text: 'What does the hero say?' }, 'textbox', 'Message'),
  enter,
  look('assistant.wait', { runId: 'run_1' }, { reason: 'terminal', status: 'no-changes', ask: true, text: EXPECT.answer }),
  click('menuitemradio', 'Edit, change the site'),
  input('ui.fill', { target: { ref: 'e5' }, text: 'Rename the site' }, 'textbox', 'Message'),
  enter,
  click('button', ALLOW),
  inPreview(EXPECT.newName),
  click('button', 'Undo Rename the site'),
  inPreview(EXPECT.oldName),
  click('button', 'Redo Rename the site'),
  look('project.summary', {}, { revision: 9, site: EXPECT.newName }),
  look('wait.for', { condition: 'export.finished' }, { condition: 'export.finished', met: true, outcome: 'exported', export: 'exports/quayside-rooms-site', kind: 'site' }),
  look('exports.inspect', { path: 'exports/quayside-rooms-site', find: EXPECT.edit }, { type: 'folder', found: 2, complete: true })
];
const record = (steps: Step[], over: Partial<JourneyRecord> = {}): JourneyRecord => ({
  scenario: { fixture: 'welcome', provider: 'scripted' },
  complete: true,
  steps: steps.map((s, i) => ({ seq: i + 1, id: `r${i + 1}`, t: i, window: 1, ...s })),
  ...over
});
const missing = (r: JourneyRecord, expect = EXPECT) => proveJourney(r, expect).witnesses.filter((w) => w.seq === null).map((w) => w.id);
const without = (match: (s: Step) => boolean) => JOURNEY.filter((s) => !match(s));
const replace = (match: (s: Step) => boolean, by: Step) => JOURNEY.map((s) => (match(s) ? by : s));
const named = (s: Step, re: RegExp) => re.test(s.targets?.[0]?.name ?? '');

describe('proveJourney (issue #498)', () => {
  it('finds every part of the principal journey, in order, in the record', () => {
    const p = proveJourney(record(JOURNEY), EXPECT);
    expect(p.ok, describeProof(p)).toBe(true);
    expect(p.witnesses.map((w) => [w.id, w.seq])).toEqual([
      ['fresh', 0],
      ['created', 4],
      ['edited', 8],
      ['ask-mode', 9],
      ['asked', 11],
      ['answer', 12],
      ['edit-mode', 13],
      ['requested', 15],
      ['decided', 16],
      ['renamed', 17],
      ['preview', 17],
      ['undo', 18],
      ['undone', 19],
      ['redo', 20],
      ['redone', 21],
      ['exported', 22],
      ['export-read', 23]
    ]);
    expect(describeProof(p).split('\n')).toHaveLength(17);
  });

  it('needs a fresh, scripted session recorded from its start', () => {
    expect(missing(record(JOURNEY, { scenario: { fixture: 'business-v1', provider: 'scripted' } }))[0]).toBe('fresh');
    expect(missing(record(JOURNEY, { scenario: { fixture: 'welcome', provider: 'none' } }))[0]).toBe('fresh');
    expect(missing(record(JOURNEY, { complete: false }))).toContain('fresh');
  });

  it('takes Enter in Project name for Create, and a key on the Ask item for a click', () => {
    const keyed = replace((s) => named(s, /^Create project$/), press('Enter', 'textbox', 'Project name')).map((s) => (named(s, /^Ask/) ? press('Enter', 'menuitemradio', 'Ask, a read-only question') : s));
    expect(missing(record(keyed))).toEqual([]);
  });

  it('needs the expected edit found saved, typed into the site rather than the chat or the project name', () => {
    expect(missing(record(without((s) => s.op === 'project.summary' && !!s.args?.find)))).toContain('edited');
    // The starter's own text, typed in again and found, is not the expected edit.
    const starterText = JOURNEY.map((s) => (s.args?.text === EXPECT.edit ? { ...s, args: { ...s.args, text: 'Calm, considered spaces' } } : s.args?.find === EXPECT.edit && s.op === 'project.summary' ? look('project.summary', { find: 'Calm, considered spaces' }, { found: 1 }) : s));
    expect(missing(record(starterText))).toContain('edited');
    const nothingFound = replace((s) => s.op === 'project.summary' && !!s.args?.find, look('project.summary', { find: EXPECT.edit }, { found: 0 }));
    expect(missing(record(nothingFound))).toContain('edited');
    // Typed into the composer instead of the site, after the project was created.
    const intoChat = JOURNEY.map((s) => (s.args?.text === EXPECT.edit ? input('ui.fill', { target: { ref: 'e3' }, text: EXPECT.edit }, 'textbox', 'Message') : s));
    expect(missing(record(intoChat))).toContain('edited');
  });

  it('needs the question asked in Ask mode and its answer seen, then an edit requested in Edit mode', () => {
    expect(missing(record(without((s) => named(s, /^Ask/))))).toContain('ask-mode');
    // A look while the run was still working is no answer, nor is another answer than the scripted one.
    expect(missing(record(replace((s) => s.op === 'assistant.wait', look('assistant.wait', { runId: 'run_1' }, { reason: 'input', status: 'awaiting-input' }))))).toEqual(['answer']);
    expect(missing(record(replace((s) => s.op === 'assistant.wait', look('assistant.observe', { after: 0 }, {}))))).toEqual(['answer']);
    expect(missing(record(replace((s) => s.op === 'assistant.wait', look('assistant.wait', { runId: 'run_1' }, { reason: 'terminal', ask: true, text: 'Something else.' }))))).toEqual(['answer']);
    // The finished question's own heading on screen is an answer seen; waiting for it to go is not.
    expect(missing(record(replace((s) => s.op === 'assistant.wait', look('wait.for', { condition: 'ui.present', role: 'button', name: 'Answered · site unchanged', exact: false }, { met: true }))))).toEqual([]);
    expect(missing(record(replace((s) => s.op === 'assistant.wait', look('wait.for', { condition: 'ui.absent', role: 'button', name: 'Answered · site unchanged', exact: false }, { met: true }))))).toEqual(['answer']);
    expect(missing(record(without((s) => named(s, /^Edit/))))).toContain('requested');
  });

  it('needs the wider change allowed, and the site seen under its new name, its old one after Undo, and the new one after Redo', () => {
    // Declining is a decision, but not the journey's: nothing is renamed.
    expect(missing(record(replace((s) => named(s, /^Yes/), click('button', 'No, only change the selection'))))).toContain('decided');
    // Not seen renamed until after the Redo: there is no Undo of a rename seen to have happened.
    expect(missing(record(without((s) => s.args?.name === EXPECT.newName)))).toEqual(['undo', 'undone', 'redo', 'redone', 'exported', 'export-read']);
    // An Undo that changed only text being typed leaves the new name: nothing shows the old one.
    const composerUndo = JOURNEY.map((s) => (named(s, /^Undo/) ? press('Meta+z', 'textbox', 'Message') : s)).filter((s) => s.args?.name !== EXPECT.oldName);
    expect(missing(record(composerUndo))).toEqual(['undone', 'redo', 'redone', 'exported', 'export-read']);
    // The new name looked for only in the editor (a field holding it) is not the site renamed: only the summary after the
    // Redo shows it, too late for the Undo.
    const inEditor = proveJourney(record(replace((s) => s.args?.name === EXPECT.newName, look('ui.locate', { role: 'textbox', name: EXPECT.newName, scope: 'editor' }, { name: EXPECT.newName }))), EXPECT);
    expect([inEditor.witnesses.find((w) => w.id === 'renamed')?.seq, inEditor.ok]).toEqual([21, false]);
    // Waiting for the new name to go, or finding a name that only contains the old one, is not seeing the old name back.
    const absent = replace((s) => s.args?.name === EXPECT.oldName, look('ui.waitFor', { role: 'link', name: EXPECT.newName, scope: 'preview', state: 'absent' }, {}));
    expect(missing(record(absent))).toEqual(['undone', 'redo', 'redone', 'exported', 'export-read']);
    const partial = replace((s) => s.args?.name === EXPECT.oldName, look('wait.for', { condition: 'ui.present', role: 'link', name: 'Harbour', exact: false, scope: 'preview' }, { met: true }));
    expect(missing(record(partial))).toEqual(['undone', 'redo', 'redone', 'exported', 'export-read']);
    // The name the app reported reaching counts over the words searched for: "allow" found the whole choice.
    const searched = replace((s) => named(s, /^Yes/), { ...click('button', ALLOW), targets: [{ at: 'target', role: 'button', name: 'allow', exact: false, replayable: true }] });
    expect(missing(record(searched))).toEqual([]);
    // Undo before Redo; the keyboard and the Edit menu count as well.
    const keys = JOURNEY.map((s) => (named(s, /^Undo/) ? press('ControlOrMeta+z') : named(s, /^Redo/) ? input('menu.invoke', { path: ['Edit', 'Redo'] }) : s));
    expect(missing(record(keys))).toEqual([]);
    const reversed = JOURNEY.map((s) => (named(s, /^Undo/) ? input('menu.invoke', { path: ['Edit', 'Undo'] }) : named(s, /^Redo/) ? press('ControlOrMeta+Shift+z') : s));
    expect(missing(record(reversed))).toEqual([]);
  });

  it('needs an export after the Redo that finished as exported, and that export read back holding the edit', () => {
    const failed = replace((s) => s.args?.condition === 'export.finished', look('wait.for', { condition: 'export.finished' }, { outcome: 'failed' }));
    expect(missing(record(failed))).toEqual(['exported', 'export-read']);
    // An export made before the assistant's change does not count.
    const exportStep = JOURNEY.find((s) => s.args?.condition === 'export.finished')!;
    const early = [...JOURNEY.slice(0, 8), exportStep, ...JOURNEY.slice(8).filter((s) => s !== exportStep)];
    expect(missing(record(early))).toEqual(['exported', 'export-read']);
    expect(missing(record(without((s) => s.op === 'exports.inspect')))).toEqual(['export-read']);
    // The editable project exported instead of the website, or an export the record cannot name, does not count.
    const source = replace((s) => s.args?.condition === 'export.finished', look('wait.for', { condition: 'export.finished' }, { outcome: 'exported', export: 'exports/quayside-rooms-source', kind: 'source' }));
    expect(missing(record(source))).toEqual(['exported', 'export-read']);
    const unnamed = replace((s) => s.args?.condition === 'export.finished', look('wait.for', { condition: 'export.finished' }, { outcome: 'exported', kind: 'site' }));
    expect(missing(record(unnamed))).toEqual(['exported', 'export-read']);
    // Another folder, or a search that found nothing, is not that export read back.
    expect(missing(record(replace((s) => s.op === 'exports.inspect', look('exports.inspect', { path: 'exports/older-site', find: EXPECT.edit }, { found: 2 }))))).toEqual(['export-read']);
    expect(missing(record(replace((s) => s.op === 'exports.inspect', look('exports.inspect', { path: 'exports/quayside-rooms-site', find: EXPECT.edit }, { found: 0 }))))).toEqual(['export-read']);
  });

  it('names the inputs a smoke run must not make: turning on Developer mode', () => {
    expect(forbiddenSteps(record(JOURNEY))).toEqual([]);
    expect(forbiddenSteps(record([...JOURNEY, click('switch', 'Developer mode')]))).toEqual([JOURNEY.length + 1]);
  });

  it('gives no credit for a step that failed', () => {
    const refused = (re: RegExp) => JOURNEY.map((s) => (named(s, re) ? { ...s, outcome: { ok: false, code: 'NOT_ACTIONABLE' } } : s));
    expect(missing(record(refused(/^Create project$/)))[0]).toBe('created');
    expect(missing(record(refused(/^Undo/)))).toEqual(['undo', 'undone', 'redo', 'redone', 'exported', 'export-read']);
  });
});
