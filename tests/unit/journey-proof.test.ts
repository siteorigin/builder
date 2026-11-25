import { describe, expect, it } from 'vitest';
import type { JournalEntry } from '../driver/evidence';
import { describeProof, proveJourney } from '../coverage/journey-proof';
import type { JourneyRecord } from '../coverage/journey-proof';

type Step = Omit<JournalEntry, 'seq' | 'id' | 't' | 'window'>;
const input = (op: string, args: Record<string, unknown>, role?: string, name?: string, summary?: Record<string, unknown>): Step => ({
  op,
  class: 'input',
  args,
  ...(role ? { targets: [{ at: 'target', role, name, replayable: true }] } : {}),
  outcome: { ok: true, ...(summary ? { summary } : {}) }
});
const click = (role: string, name: string) => input('ui.click', { target: { ref: 'e1' } }, role, name);
const look = (op: string, args: Record<string, unknown>, summary: Record<string, unknown> = {}): Step => ({ op, class: 'observation', args, outcome: { ok: true, summary } });
const enter = input('ui.press', { key: 'Enter' }, undefined, undefined, { target: { surface: 'editor', role: 'textbox', name: 'Message' } });

/** The principal journey as the Node test records it. */
const JOURNEY: Step[] = [
  look('ui.snapshot', {}),
  click('button', 'New project'),
  input('ui.fill', { target: { ref: 'e2' }, text: 'Harbour Lane Studio' }, 'textbox', 'Project name'),
  { op: 'desktop.setAnswers', class: 'setup', args: { answers: [] }, outcome: { ok: true } },
  click('button', 'Choose…'),
  click('button', 'Create project'),
  look('wait.for', { condition: 'preview.ready', path: '/' }, { condition: 'preview.ready', met: true }),
  input('ui.fill', { target: { ref: 'e3' }, text: 'Harbour light in every season' }, 'textbox', 'Heading'),
  look('wait.for', { condition: 'save.settled' }),
  look('project.summary', { find: 'Harbour light in every season' }, { revision: 4, found: 1, complete: true }),
  click('menuitemradio', 'Ask, a read-only question'),
  input('ui.fill', { target: { ref: 'e4' }, text: 'What does the hero say?' }, 'textbox', 'Message'),
  enter,
  look('assistant.wait', { runId: 'run_1' }),
  click('menuitemradio', 'Edit, change the site'),
  input('ui.fill', { target: { ref: 'e5' }, text: 'Rename the site' }, 'textbox', 'Message'),
  enter,
  click('button', 'Yes, allow changes across the whole site'),
  look('wait.for', { condition: 'ui.present', role: 'link', name: 'Harbour Light Studio', scope: 'preview' }),
  click('button', 'Undo Rename the site'),
  click('button', 'Redo Rename the site'),
  look('wait.for', { condition: 'export.finished' }, { condition: 'export.finished', met: true, outcome: 'exported' }),
  look('exports.inspect', { path: 'exports/harbour-site', find: 'Harbour light in every season' }, { type: 'folder', found: 2, complete: true })
];
const record = (steps: Step[], over: Partial<JourneyRecord> = {}): JourneyRecord => ({
  scenario: { fixture: 'welcome', provider: 'scripted' },
  complete: true,
  steps: steps.map((s, i) => ({ seq: i + 1, id: `r${i + 1}`, t: i, window: 1, ...s })),
  ...over
});
const missing = (r: JourneyRecord) => proveJourney(r).witnesses.filter((w) => w.seq === null).map((w) => w.id);
const without = (match: (s: Step) => boolean) => JOURNEY.filter((s) => !match(s));

describe('proveJourney (issue #498)', () => {
  it('finds every part of the principal journey, in order, in the record', () => {
    const p = proveJourney(record(JOURNEY));
    expect(p.ok).toBe(true);
    expect(p.witnesses.map((w) => [w.id, w.seq])).toEqual([
      ['fresh', 0],
      ['created', 6],
      ['edited', 10],
      ['ask-mode', 11],
      ['asked', 13],
      ['answer', 14],
      ['edit-mode', 15],
      ['requested', 17],
      ['decided', 18],
      ['preview', 19],
      ['undo', 20],
      ['redo', 21],
      ['exported', 22],
      ['export-read', 23]
    ]);
    expect(describeProof(p).split('\n')).toHaveLength(14);
  });

  it('needs a fresh session recorded from its start', () => {
    expect(missing(record(JOURNEY, { scenario: { fixture: 'business-v1', provider: 'scripted' } }))[0]).toBe('fresh');
    expect(missing(record(JOURNEY, { complete: false }))).toContain('fresh');
  });

  it('needs the edit to be found saved, and typed into the site rather than the chat or the project name', () => {
    expect(missing(record(without((s) => s.op === 'project.summary')))).toEqual(['edited']);
    const onlyChat = JOURNEY.map((s) => (s.op === 'project.summary' ? look('project.summary', { find: 'Rename the site' }, { found: 1 }) : s));
    expect(missing(record(onlyChat))).toEqual(['edited']);
    const nothingFound = JOURNEY.map((s) => (s.op === 'project.summary' ? look('project.summary', { find: 'Harbour light in every season' }, { found: 0 }) : s));
    expect(missing(record(nothingFound))).toEqual(['edited']);
  });

  it('needs the question asked in Ask mode, its answer read, and an edit requested in Edit mode', () => {
    expect(missing(record(without((s) => s.op === 'ui.click' && s.targets?.[0].name?.startsWith('Ask') === true)))).toEqual(['ask-mode', 'asked', 'answer', 'edit-mode', 'requested', 'decided', 'preview', 'undo', 'redo']);
    expect(missing(record(without((s) => s.op === 'assistant.wait')))).toEqual(['answer']);
    expect(missing(record(without((s) => s.op === 'ui.click' && s.targets?.[0].name?.startsWith('Edit') === true)))).toContain('requested');
  });

  it('needs the decision, then an Undo and a Redo after it, in that order', () => {
    expect(missing(record(without((s) => s.targets?.[0].name?.startsWith('Yes') === true)))).toEqual(['decided', 'preview', 'undo', 'redo']);
    const swapped = [...JOURNEY];
    [swapped[19], swapped[20]] = [swapped[20], swapped[19]];
    expect(missing(record(swapped))).toEqual(['redo']);
    // The keyboard and the Edit menu count as well.
    const keys = JOURNEY.map((s) => (s.targets?.[0].name?.startsWith('Undo') ? input('ui.press', { key: 'ControlOrMeta+z' }) : s.targets?.[0].name?.startsWith('Redo') ? input('menu.invoke', { path: ['Edit', 'Redo'] }) : s));
    expect(proveJourney(record(keys)).ok).toBe(true);
  });

  it('needs an export that finished as exported and whose files were read back', () => {
    const failed = JOURNEY.map((s) => (s.op === 'wait.for' && s.args?.condition === 'export.finished' ? look('wait.for', { condition: 'export.finished' }, { outcome: 'failed' }) : s));
    expect(missing(record(failed))).toEqual(['exported', 'export-read']);
    expect(missing(record(without((s) => s.op === 'exports.inspect')))).toEqual(['export-read']);
  });

  it('gives no credit for a step that failed', () => {
    const refused = JOURNEY.map((s) => (s.targets?.[0].name === 'Create project' ? { ...s, outcome: { ok: false, code: 'NOT_ACTIONABLE' } } : s));
    expect(missing(record(refused))[0]).toBe('created');
  });
});
