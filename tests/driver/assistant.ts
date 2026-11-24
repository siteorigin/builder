/**
 * The Builder assistant, exercised as a user (issue #495). A test talks to the assistant only through what a person
 * uses (the composer, the mode and scope menus, the image picker, the question card, Stop, the result card's buttons
 * and the conversation history, all through `ui.*`); this module gives it what it needs around that:
 *
 * - **Scripted replies.** In a scripted session the assistant's model is a local server in the session's process
 *   (tests/unit/mock-openai-server.ts) behind the app's real local adapter and orchestrator. `assistant.script` sets
 *   what it answers, request by request: a named scenario, or a list of steps, each one model turn (a tool call, a
 *   provider error) that may be held at a gate until `assistant.release`. Arguments can name what is only known when
 *   the request arrives: `{ "$context": "selection.nodeId" }` from the editor context it carries, and
 *   `{ "$result": "nodeId" }` from the latest tool result in it.
 *
 * - **Observations keyed by run.** The app keeps every assistant event in order in automated runs
 *   (src/main/ai-journal.ts). The tracker here turns them into entries keyed by conversation, message and run: a run
 *   started (with the request's own message), its status, its steps, its questions and their answers, its model, its
 *   text and its result. Each entry carries the journal's `seq`, a cursor that survives panel changes, conversation
 *   switches, reloads and reopening the project. Alongside, `readChat` reads what the chat panel shows, by the same IDs.
 *
 * - **Waits that return when the author must act.** `settledState` says whether a run is finished or waiting for the
 *   author. A wait names its run: another run's events never satisfy it.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MockReply, MockRequest } from '../unit/mock-openai-server.ts';
import { envelopeReply } from '../unit/mock-openai-server.ts';
import { DriverError } from './protocol.ts';

/** The statuses a run ends with. */
export const TERMINAL_STATUSES = ['completed', 'no-changes', 'cancelled', 'failed', 'conflicted'] as const;
const TERMINAL = new Set<string>(TERMINAL_STATUSES);

// ---------------------------------------------------------------------------
// Journal records → entries
// ---------------------------------------------------------------------------

/** One event as the app's journal kept it. */
export interface RawRecord {
  seq: number;
  at: number;
  event: unknown;
}

export interface QuestionView {
  questionId: string | null;
  text: string;
  choices: string[];
  /** Only its choices grant it: a request to change more than the request was limited to. */
  widen?: true;
  /** Library images offered as choices. */
  images?: Array<{ assetId: string; name: string }>;
}

export interface ResultView {
  status: string;
  summary: string;
  error?: string;
  /** What changed, in plain words. */
  changes: string[];
  ask?: true;
  incomplete?: true;
  repair?: string;
  canUndo: boolean;
}

export interface StepView {
  id: string;
  label: string;
  status: string;
  detail?: string;
}

export type EntryType = 'run.started' | 'status' | 'text' | 'step' | 'question' | 'answer' | 'model' | 'result' | 'update' | 'gap';

/** One thing that happened to a run, in the order the app sent it. Several entries may share a `seq`. */
export interface Entry {
  seq: number;
  at: string;
  type: EntryType;
  conversationId: string | null;
  runId: string | null;
  /** The assistant message of the run (the user's request has its own, in run.started). */
  messageId: string | null;
  /** run.started: the request, as the author sent it. */
  request?: { messageId: string | null; text: string; mode: 'edit' | 'ask'; target?: string; page?: string; images?: string[] };
  status?: string;
  mode?: 'edit' | 'ask';
  text?: string;
  step?: StepView;
  question?: QuestionView;
  answer?: { questionId: string | null; text: string; assetId?: string };
  model?: { provider?: string; id?: string; label?: string };
  result?: ResultView;
  /** gap: how many events were dropped before they could be read. */
  missed?: number;
  /** The run's events no longer name its conversation: its project was closed while it ran. */
  detached?: true;
}

/** Where a run stands: working, waiting for the author, finishing (its status is final, its result on the way), or over. */
export type RunState = 'working' | 'input' | 'ending' | 'terminal';

/** A run as the journal tells it so far. */
export interface RunView {
  runId: string;
  conversationId: string | null;
  mode: 'edit' | 'ask';
  userMessageId: string | null;
  messageId: string | null;
  request: string | null;
  /** What the request was about, as its caption names it, the page it was sent from, and the images sent with it. */
  target?: string;
  page?: string;
  images?: string[];
  status: string | null;
  state: RunState;
  /** The question waiting for the author, when the run waits for one. */
  question: (QuestionView & { askedSeq: number }) | null;
  /** Every question the run asked, in order, with its answer once given. */
  questions: Array<QuestionView & { askedSeq: number; answer?: string; answerAssetId?: string; answeredSeq?: number }>;
  steps: StepView[];
  text: string;
  model: { provider?: string; id?: string; label?: string } | null;
  result: ResultView | null;
  startedSeq: number;
  lastSeq: number;
  detached?: true;
  /** Events of this run may have been dropped before they were read: until its next turn update, a question it shows may already be answered. */
  gap?: true;
}

interface Run {
  view: RunView;
  /** The assistant message as last sent, to tell what each new copy changed. */
  last: Record<string, any> | null;
}

const isRecord = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function questionsOf(m: Record<string, any>): Array<Record<string, any>> {
  if (Array.isArray(m.questions)) return m.questions.filter(isRecord);
  return isRecord(m.question) ? [m.question] : [];
}

function questionView(q: Record<string, any>): QuestionView {
  const images = Array.isArray(q.images) ? q.images.filter((i: unknown) => isRecord(i) && typeof i.assetId === 'string').map((i: Record<string, any>) => ({ assetId: i.assetId, name: str(i.name) })) : [];
  return {
    questionId: typeof q.id === 'string' ? q.id : null,
    text: str(q.text),
    choices: Array.isArray(q.choices) ? q.choices.filter((c: unknown): c is string => typeof c === 'string') : [],
    ...(q.widen === true ? { widen: true as const } : {}),
    ...(images.length ? { images } : {})
  };
}

function resultView(r: Record<string, any>): ResultView {
  return {
    status: str(r.status),
    summary: str(r.summary),
    ...(typeof r.error === 'string' && r.error ? { error: r.error } : {}),
    changes: Array.isArray(r.changes) ? r.changes.map((c: unknown) => (isRecord(c) ? str(c.label) : '')).filter(Boolean) : [],
    ...(r.ask === true ? { ask: true as const } : {}),
    ...(r.incomplete === true ? { incomplete: true as const } : {}),
    ...(typeof r.repair === 'string' ? { repair: r.repair } : {}),
    canUndo: r.canUndo === true
  };
}

function modelView(m: unknown): RunView['model'] {
  if (!isRecord(m)) return null;
  return { ...(typeof m.provider === 'string' ? { provider: m.provider } : {}), ...(typeof m.id === 'string' ? { id: m.id } : {}), ...(typeof m.label === 'string' ? { label: m.label } : {}) };
}

/** A request's target as its context names it, in the words the chat shows under it. */
function targetOf(ctx: Record<string, any> | undefined): string | undefined {
  if (!ctx) return undefined;
  if (isRecord(ctx.component) && typeof ctx.component.name === 'string') return typeof ctx.selectionLabel === 'string' && ctx.selectionLabel ? `${ctx.component.name} → ${ctx.selectionLabel}` : ctx.component.name;
  if (typeof ctx.selectionLabel === 'string' && ctx.selectionLabel) return ctx.selectionLabel;
  if (ctx.scope === 'site') return 'Whole site';
  return typeof ctx.pageTitle === 'string' && ctx.pageTitle ? ctx.pageTitle : undefined;
}

export interface TrackerOptions {
  /** Entries kept; the oldest go first. */
  maxEntries?: number;
  /** Runs kept; the oldest finished ones go first. */
  maxRuns?: number;
}

/**
 * Follows the app's journal: ingest its records in order and read entries after a cursor, and each run's state.
 * Pure: the session feeds it what it read from the app.
 */
export class AssistantTracker {
  private entries: Entry[] = [];
  private runs = new Map<string, Run>();
  /** The request message each run started with, until its assistant message arrives. */
  private requests = new Map<string, Record<string, any>>();
  /** The latest journal seq ingested. */
  cursor = 0;
  /** The latest seq some of whose entries were let go (0: none yet). */
  private dropped = 0;
  private readonly maxEntries: number;
  private readonly maxRuns: number;

  constructor(opts: TrackerOptions = {}) {
    this.maxEntries = opts.maxEntries ?? 5000;
    this.maxRuns = opts.maxRuns ?? 500;
  }

  /** The oldest seq whose entries are all still kept. */
  get oldest(): number {
    return this.dropped + 1;
  }

  /** Take in the journal's records after `cursor`; `missed` is how many the journal dropped before they were read. */
  ingest(records: RawRecord[], missed = 0) {
    if (missed > 0) {
      const at = records[0]?.at ?? Date.now();
      const seq = (records[0]?.seq ?? this.cursor + missed + 1) - 1;
      this.push({ seq, at: new Date(at).toISOString(), type: 'gap', conversationId: null, runId: null, messageId: null, missed });
      this.cursor = Math.max(this.cursor, seq);
      // What a run still going did meanwhile is unknown until it next sends its whole turn.
      for (const r of this.runs.values()) if (r.view.state !== 'terminal') r.view.gap = true;
    }
    for (const r of records) {
      if (r.seq <= this.cursor) continue;
      this.cursor = r.seq;
      this.one(r);
    }
  }

  private push(e: Entry) {
    this.entries.push(e);
    // Entries go a whole seq at a time, so a page never holds part of one event.
    while (this.entries.length > this.maxEntries && this.entries[0].seq !== e.seq) {
      const seq = this.entries[0].seq;
      while (this.entries[0]?.seq === seq) this.entries.shift();
      this.dropped = seq;
    }
  }

  private run(runId: string, conversationId: string, seq: number): Run {
    let run = this.runs.get(runId);
    if (!run) {
      const req = this.requests.get(runId);
      this.requests.delete(runId);
      const ctx = isRecord(req?.context) ? req!.context : undefined;
      const details = req ? requestDetails(req) : {};
      run = {
        view: {
          runId,
          conversationId: conversationId || null,
          mode: ctx?.mode === 'ask' ? 'ask' : 'edit',
          userMessageId: typeof req?.id === 'string' ? req.id : null,
          messageId: null,
          request: typeof req?.text === 'string' ? req.text : null,
          ...details,
          status: null,
          state: 'working',
          question: null,
          questions: [],
          steps: [],
          text: '',
          model: null,
          result: null,
          startedSeq: seq,
          lastSeq: seq
        },
        last: null
      };
      this.runs.set(runId, run);
      while (this.runs.size > this.maxRuns) {
        const oldest = [...this.runs.values()].find((r) => r.view.state === 'terminal') ?? this.runs.values().next().value!;
        this.runs.delete(oldest.view.runId);
      }
    }
    run.view.lastSeq = seq;
    if (!run.view.conversationId && conversationId) run.view.conversationId = conversationId;
    return run;
  }

  private one(r: RawRecord) {
    const e = r.event;
    const at = new Date(r.at).toISOString();
    if (!isRecord(e)) return;
    const runId = str(e.runId);
    const conversationId = str(e.conversationId);
    if (e.kind === 'message' && isRecord(e.message)) {
      const m = e.message;
      // A request's own message comes first: it is kept until the run's assistant message names the run.
      if (m.role === 'user') {
        const known = runId ? this.runs.get(runId) : undefined;
        // A run first seen by its status takes its request when the request arrives.
        if (known && !known.view.userMessageId) {
          const ctx = isRecord(m.context) ? m.context : undefined;
          Object.assign(known.view, { userMessageId: str(m.id) || null, request: str(m.text), mode: ctx?.mode === 'ask' ? 'ask' : known.view.mode, ...requestDetails(m) });
        } else if (runId && !known) {
          this.requests.set(runId, m);
          // A request whose run never showed is let go once there are too many to be one still starting.
          if (this.requests.size > 20) this.requests.delete(this.requests.keys().next().value!);
        }
        return;
      }
      const id = str(m.runId) || runId;
      if (!id) {
        // Outside any run (an Undo beside a finished request): the transcript changed, nothing ran.
        this.push({ seq: r.seq, at, type: 'update', conversationId: conversationId || null, runId: null, messageId: str(m.id) || null });
        return;
      }
      const run = this.run(id, conversationId, r.seq);
      const v = run.view;
      const base = { seq: r.seq, at, conversationId: v.conversationId, runId: id, ...(runId && !conversationId && v.conversationId ? { detached: true as const } : {}) };
      if (base.detached) v.detached = true;
      if (!v.messageId) {
        v.messageId = str(m.id) || null;
        const request = { messageId: v.userMessageId, text: v.request ?? '', mode: v.mode, ...(v.target ? { target: v.target } : {}), ...(v.page ? { page: v.page } : {}), ...(v.images ? { images: v.images } : {}) };
        this.push({ ...base, messageId: v.messageId, type: 'run.started', request });
      }
      this.diff(run, m, base);
      run.last = m;
      // The whole turn, as it is now: whatever a gap hid of its questions and result is known again.
      delete v.gap;
      this.settle(v);
      return;
    }
    if (!runId) return;
    const run = this.run(runId, conversationId, r.seq);
    const v = run.view;
    const base = { seq: r.seq, at, conversationId: v.conversationId, runId, messageId: v.messageId, ...(!conversationId && v.conversationId ? { detached: true as const } : {}) };
    if (base.detached) v.detached = true;
    if (e.kind === 'status' && typeof e.status === 'string') {
      v.status = e.status;
      if (e.mode === 'ask' || e.mode === 'edit') v.mode = e.mode;
      this.push({ ...base, type: 'status', status: e.status, ...(e.mode === 'ask' || e.mode === 'edit' ? { mode: e.mode } : {}) });
    } else if (e.kind === 'text') {
      v.text = str(e.text);
      this.push({ ...base, type: 'text', text: v.text });
    }
    this.settle(v);
  }

  private diff(run: Run, m: Record<string, any>, base: Pick<Entry, 'seq' | 'at' | 'conversationId' | 'runId' | 'detached'>) {
    const v = run.view;
    const prev = run.last ?? {};
    const e = (x: Omit<Entry, 'seq' | 'at' | 'conversationId' | 'runId' | 'detached' | 'messageId'>) => this.push({ ...base, messageId: v.messageId, ...x });
    if (!prev.model && m.model) {
      v.model = modelView(m.model);
      if (v.model) e({ type: 'model', model: v.model });
    }
    const before = new Map<string, Record<string, any>>((Array.isArray(prev.activities) ? prev.activities : []).filter(isRecord).map((a: Record<string, any>) => [str(a.id), a]));
    const steps: StepView[] = [];
    for (const a of Array.isArray(m.activities) ? m.activities.filter(isRecord) : []) {
      const step: StepView = { id: str(a.id), label: str(a.label), status: str(a.status), ...(typeof a.detail === 'string' && a.detail ? { detail: a.detail } : {}) };
      steps.push(step);
      const was = before.get(step.id);
      if (!was || str(was.status) !== step.status || str(was.label) !== step.label || str(was.detail) !== (step.detail ?? '')) e({ type: 'step', step });
    }
    v.steps = steps;
    const asked = questionsOf(prev);
    questionsOf(m).forEach((q, i) => {
      const view = questionView(q);
      const was = view.questionId ? asked.find((x) => x.id === view.questionId) : asked[i];
      let known = v.questions.find((x, j) => (view.questionId ? x.questionId === view.questionId : j === i));
      if (!was || !known) {
        known = { ...view, askedSeq: base.seq };
        v.questions.push(known);
        e({ type: 'question', question: view });
      }
      if (typeof q.answered === 'string' && known.answer === undefined) {
        known.answer = q.answered;
        known.answeredSeq = base.seq;
        if (typeof q.answeredAssetId === 'string') known.answerAssetId = q.answeredAssetId;
        e({ type: 'answer', answer: { questionId: view.questionId, text: q.answered, ...(typeof q.answeredAssetId === 'string' ? { assetId: q.answeredAssetId } : {}) } });
      }
    });
    // An empty text counts too: a run that stops at a limit clears what it was writing.
    if (typeof m.text === 'string' && m.text !== v.text) {
      v.text = m.text;
      e({ type: 'text', text: m.text });
    }
    if (isRecord(m.result) && JSON.stringify(m.result) !== JSON.stringify(prev.result)) {
      v.result = resultView(m.result);
      e({ type: 'result', result: v.result });
    }
  }

  /** Work out where a run stands from its status, its questions and its result. */
  private settle(v: RunView) {
    const open = [...v.questions].reverse().find((q) => q.answer === undefined) ?? null;
    if (v.result) {
      // A turn has a result only once its run is over, whatever status was last read (one may have been dropped).
      v.state = 'terminal';
      v.question = null;
    } else if (v.status && TERMINAL.has(v.status)) {
      v.state = 'ending';
      v.question = null;
    } else if (v.status === 'awaiting-input' && open) {
      v.state = 'input';
      v.question = open;
    } else {
      v.state = 'working';
      v.question = null;
    }
  }

  /** The entries after `after` that match the filter, at most `limit` (all of one seq or none). */
  read(opts: { after?: number; limit?: number; runId?: string; conversationId?: string } = {}): { entries: Entry[]; next: number; oldest: number; latest: number; missed: number } {
    const after = opts.after ?? 0;
    const limit = opts.limit ?? 200;
    const oldest = this.oldest;
    // Journal events after the cursor whose entries are no longer kept, and those the journal dropped unread.
    let missed = Math.max(0, this.dropped - after);
    const out: Entry[] = [];
    let next = after;
    for (const e of this.entries) {
      if (e.seq <= after) continue;
      // A page ends between seqs, never inside one.
      if (out.length >= limit && e.seq !== next) break;
      next = e.seq;
      if (e.type === 'gap') missed += e.missed ?? 0;
      // A gap is everyone's: no filter hides that something was missed.
      if (e.type !== 'gap' && opts.runId && e.runId !== opts.runId) continue;
      if (e.type !== 'gap' && opts.conversationId && e.conversationId !== opts.conversationId) continue;
      out.push(e);
    }
    // Read to the end: the cursor moves past what the journal has, even with nothing that matched.
    if (out.length < limit || this.entries.at(-1)?.seq === next) next = Math.max(next, this.cursor);
    return { entries: out, next, oldest, latest: this.cursor, missed };
  }

  /** One run as it stands, or null when the tracker never saw it (or has let it go). */
  runView(runId: string): RunView | null {
    const r = this.runs.get(runId);
    return r ? structuredClone(r.view) : null;
  }

  /** Every run kept, oldest first, optionally only one conversation's. */
  runViews(conversationId?: string): RunView[] {
    return [...this.runs.values()].map((r) => r.view).filter((v) => !conversationId || v.conversationId === conversationId).map((v) => structuredClone(v));
  }

}

/** What a request message was about (its target, as the chat captions it) and the images sent with it. */
export function requestDetails(m: Record<string, any>): { target?: string; page?: string; images?: string[] } {
  const ctx = isRecord(m.context) ? m.context : undefined;
  const target = targetOf(ctx);
  const page = typeof ctx?.pageTitle === 'string' && ctx.pageTitle ? ctx.pageTitle : undefined;
  const images = Array.isArray(m.images) ? m.images.filter((i: unknown) => isRecord(i) && typeof i.assetId === 'string').map((i: Record<string, any>) => i.assetId as string) : [];
  return { ...(target ? { target } : {}), ...(page ? { page } : {}), ...(images.length ? { images } : {}) };
}

/**
 * Whether a run is somewhere a wait for it ends: finished, or waiting for the author. `after` is a cursor taken before
 * the author last acted: a question asked at or before it is the one just answered, not a new one. A finished run is
 * finished whatever the cursor.
 */
export function settledState(run: RunView, after?: number): { reason: 'terminal' | 'input' } | null {
  if (run.state === 'terminal') return { reason: 'terminal' };
  // After a gap, the question it shows may already be answered: it waits for the run's next turn update.
  if (run.state === 'input' && run.question && !run.gap && (after === undefined || run.question.askedSeq > after)) return { reason: 'input' };
  return null;
}

// ---------------------------------------------------------------------------
// What the chat panel shows
// ---------------------------------------------------------------------------

export interface ShownMessage {
  messageId: string | null;
  role: 'user' | 'assistant';
  runId?: string | null;
  /** The words of the message: the request, or the reply while it is written. */
  text: string;
  /** The caption under a request: what it was about, and whether it was a question. */
  caption?: string;
  /** Library images shown with it, by asset ID. */
  images?: string[];
  /** Whether it is still being worked on (the log reads it once it settles). */
  busy?: boolean;
  /** Steps listed while it runs. */
  steps?: string[];
  /** Questions asked during it, with the answers, as the turn shows them. */
  answers?: Array<{ question: string; answer: string | null; images?: string[] }>;
  /** The finished turn's card. */
  result?: { status: string; heading: string; qualifiers?: string; summary: string; standing?: string; changes?: string[]; buttons: string[] };
  /** The model it went to, as shown under it. */
  model?: string;
}

export interface ShownChat {
  /** The AI panel is the one the dock shows, and the dock is open. */
  visible: boolean;
  conversationId: string | null;
  title: string | null;
  messages: ShownMessage[];
  /** The question waiting above the composer. */
  question: { runId: string | null; messageId: string | null; questionId: string | null; text: string; scopeNote?: string; hint?: string; choices: string[]; images: string[] } | null;
  /** The live run's strip: its phase, what it is about, the model, and its Stop button. */
  run: { runId: string | null; phase: string; target?: string; model?: string; stop?: string } | null;
  /** The composer: what the next message does, the scope chip, the text in it and the images attached. Display text
   *  goes under names of its own, never a protocol word (mode, scope), so a credential in it is always scrubbed. */
  composer: { present: boolean; answering: boolean; placeholder: string | null; value: string; modeLabel?: string; scopeLabel?: string; images: string[]; send?: { label: string; disabled: boolean } } | null;
  /** Notes and errors shown in or over the panel: notices beside the composer and toasts. */
  notices: Array<{ kind: string; text: string }>;
}

/**
 * Read the chat panel as it is shown. Runs in the editor page (page.evaluate): it reads the DOM only, and is
 * self-contained.
 */
export function readChat(): ShownChat {
  // The test's own build has no DOM types: the page's objects are read untyped.
  const d = (globalThis as any).document;
  const text = (el: any) => String(el?.innerText ?? el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const visible = (el: any) => !!el && (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : !!el.offsetParent);
  const all = (root: any, sel: string): any[] => (root ? [...root.querySelectorAll(sel)] : []);
  const assets = (root: any, sel: string): string[] => all(root, sel).map((c) => c.dataset.assetId ?? '').filter(Boolean);
  const classes = (el: any): string[] => [...el.classList];
  const chat = d.querySelector('.chat');
  const notices = [
    ...all(d, '.toast').filter(visible).map((t) => ({ kind: `toast ${classes(t).filter((c) => c !== 'toast').join(' ')}`.trim(), text: text(t) })),
    ...all(chat, ':scope > .scope-note, .chat-not-ready').filter(visible).map((n) => ({ kind: classes(n).join(' '), text: text(n) }))
  ];
  if (!chat) return { visible: false, conversationId: null, title: null, messages: [], question: null, run: null, composer: null, notices };
  const log = chat.querySelector('.chat-log');
  const messages: ShownMessage[] = [];
  for (const el of all(log, ':scope > .msg-user, :scope > .msg-ai')) {
    const images = assets(el, '.image-chip');
    if (el.classList.contains('msg-user')) {
      // The request's own words are the text directly in it; its caption and images are elements of their own.
      const own = [...el.childNodes].filter((n: any) => n.nodeType === 3).map((n: any) => n.textContent ?? '').join('').trim();
      const caption = text(el.querySelector(':scope > .ctx'));
      messages.push({ messageId: el.dataset.messageId ?? null, role: 'user', text: own, ...(caption ? { caption } : {}), ...(images.length ? { images } : {}) });
      continue;
    }
    const answers = all(el, '.answered').map((a) => {
      const strong = a.querySelector('strong');
      const chips = assets(a, '.image-chip');
      return { question: text(a.querySelector('.answered-q')), answer: strong ? text(strong) : null, ...(chips.length ? { images: chips } : {}) };
    });
    const steps = all(el, ':scope > .activity-list .activity-text').map(text);
    const model = text(el.querySelector(':scope > .turn-model'));
    const m: ShownMessage = {
      messageId: el.dataset.messageId ?? null,
      role: 'assistant',
      runId: el.dataset.runId ?? null,
      text: text(el.querySelector(':scope > .text')),
      busy: el.getAttribute('aria-busy') === 'true',
      ...(steps.length ? { steps } : {}),
      ...(answers.length ? { answers } : {}),
      ...(model ? { model } : {})
    };
    const card = el.querySelector('.result-card');
    if (card) {
      const qualifiers = text(card.querySelector('.result-qualifiers'));
      const standing = text(card.querySelector('.result-standing'));
      const changes = all(card, 'ul.changes > li, ul[aria-label="Changes that were reverted"] > li').map(text);
      m.result = {
        status: classes(card).find((c) => c !== 'result-card' && c !== 'settled' && c !== 'reverted') ?? '',
        heading: text(card.querySelector('.result-title')),
        ...(qualifiers ? { qualifiers } : {}),
        summary: text(card.querySelector('.result-summary')),
        ...(standing ? { standing } : {}),
        ...(changes.length ? { changes } : {}),
        buttons: all(card, '.result-foot button').filter(visible).map(text)
      };
    }
    messages.push(m);
  }
  const card = chat.querySelector('.question-card');
  const question = card
    ? {
        runId: card.dataset.runId ?? null,
        messageId: card.dataset.messageId ?? null,
        questionId: card.dataset.questionId ?? null,
        text: text(card.querySelector('.question-text')),
        ...(card.querySelector('.question-scope') ? { scopeNote: text(card.querySelector('.question-scope')) } : {}),
        ...(card.querySelector('.question-hint') ? { hint: text(card.querySelector('.question-hint')) } : {}),
        choices: all(card, '.choices .choice').map(text),
        images: assets(card, '.image-choice')
      }
    : null;
  const strip = chat.querySelector('.run-strip');
  const run = strip
    ? {
        runId: strip.dataset.runId ?? null,
        phase: text(strip.querySelector('.run-phase')),
        ...(strip.querySelector('.run-target') ? { target: text(strip.querySelector('.run-target')) } : {}),
        ...(strip.querySelector('.run-model') ? { model: text(strip.querySelector('.run-model')) } : {}),
        ...(strip.querySelector('.run-stop') ? { stop: text(strip.querySelector('.run-stop')) } : {})
      }
    : null;
  const box = chat.querySelector('.composer');
  const area = box?.querySelector('textarea');
  const buttons = all(box, 'button');
  const modeBtn = buttons.find((b) => /^What your next message does/.test(b.getAttribute('aria-label') ?? ''));
  const scopeChip = box?.querySelector('.scope-chip');
  const send = buttons.find((b) => /^Send\b/.test(b.getAttribute('aria-label') ?? ''));
  const composer = box
    ? {
        present: true,
        answering: box.classList.contains('answering'),
        placeholder: area?.getAttribute('placeholder') ?? null,
        value: area?.value ?? '',
        ...(modeBtn ? { modeLabel: String(modeBtn.getAttribute('aria-label')).replace(/^What your next message does:\s*/, '') } : {}),
        ...(scopeChip ? { scopeLabel: scopeChip.getAttribute('aria-label') ?? text(scopeChip) } : {}),
        images: assets(box, '.image-chip'),
        ...(send ? { send: { label: send.getAttribute('aria-label') ?? text(send), disabled: !!send.disabled } } : {})
      }
    : null;
  return {
    visible: visible(chat),
    conversationId: log?.dataset.conversationId ?? null,
    title: text(chat.querySelector('.chat-title')) || null,
    messages,
    question,
    run,
    composer,
    notices
  };
}

/** The turn a run shows as, in what the panel shows now: its request and its reply, or null when they are not shown. */
export function shownTurn(chat: ShownChat, run: RunView): { visible: boolean; request: ShownMessage | null; reply: ShownMessage } | null {
  if (!run.conversationId || chat.conversationId !== run.conversationId) return null;
  const reply = chat.messages.find((m) => m.role === 'assistant' && (m.runId === run.runId || (run.messageId !== null && m.messageId === run.messageId)));
  if (!reply) return null;
  const request = (run.userMessageId && chat.messages.find((m) => m.messageId === run.userMessageId)) || null;
  return { visible: chat.visible, request, reply };
}

// ---------------------------------------------------------------------------
// Scripted replies
// ---------------------------------------------------------------------------

/** One model turn of a script. */
export type Step =
  | { tool: string; args?: Record<string, unknown>; status?: string; gate?: string; delayMs?: number }
  | { error: { status: number; message?: string }; gate?: string; delayMs?: number };

export type GateState = 'pending' | 'reached' | 'released';

/** The named scenarios and what each takes: the steps they make. */
export const SCENARIOS: Record<string, { summary: string; steps: (p: Record<string, unknown>) => Step[] }> = {
  answer: {
    summary: 'Answer at once: { text }.',
    steps: (p) => [{ tool: 'finish', args: { message: text(p, 'text') }, status: 'Answering' }]
  },
  'read-and-answer': {
    summary: 'Read the page the request was sent from, then answer: { text }.',
    steps: (p) => [
      { tool: 'read_page', args: { pageId: { $context: 'pageId' } }, status: 'Reading the page' },
      { tool: 'finish', args: { message: text(p, 'text') }, status: 'Answering' }
    ]
  },
  interview: {
    summary: 'Ask each question in turn ({ questions: [{ question, choices }] }), then answer: { then }.',
    steps: (p) => {
      const qs = Array.isArray(p.questions) ? p.questions : [];
      if (!qs.length) throw new DriverError('BAD_REQUEST', 'The interview scenario takes "questions": a list of { question, choices }.');
      return [
        ...qs.map((q, i) => {
          if (!isRecord(q) || typeof q.question !== 'string' || !q.question) throw new DriverError('BAD_REQUEST', `Question ${i + 1} needs "question": text.`);
          const choices = Array.isArray(q.choices) ? q.choices.filter((c): c is string => typeof c === 'string') : [];
          return { tool: 'request_clarification', args: { question: q.question, choices }, status: 'Asking' } as Step;
        }),
        { tool: 'finish', args: { message: text(p, 'then') }, status: 'Answering' }
      ];
    }
  },
  'edit-selection': {
    summary: 'Change the selected element’s content ({ props }), then finish: { summary }.',
    steps: (p) => {
      if (!isRecord(p.props) || !Object.keys(p.props).length) throw new DriverError('BAD_REQUEST', 'The edit-selection scenario takes "props": the properties to change.');
      return [
        { tool: 'update_selected_props', args: { props: p.props }, status: 'Editing the selection' },
        { tool: 'finish', args: { message: text(p, 'summary') }, status: 'Finishing' }
      ];
    }
  },
  widen: {
    summary: 'Ask to change more than the selection ({ question }), then finish: { then }.',
    steps: (p) => [
      { tool: 'request_wider_scope', args: { question: text(p, 'question') }, status: 'Asking' },
      { tool: 'finish', args: { message: text(p, 'then') }, status: 'Finishing' }
    ]
  },
  fail: {
    // The adapter sends a 400 or 422 again in another format and retries a 5xx, each taking the steps after it; a 409
    // it reports as it is, with the message.
    summary: 'The provider refuses the request: { status } (default 409, reported as it is; a 400 or 422 is sent again in another format and a 5xx is retried, each taking a later step), { message }.',
    steps: (p) => [{ error: { status: typeof p.status === 'number' ? p.status : 409, message: typeof p.message === 'string' ? p.message : 'The scripted provider refused the request.' } }]
  }
};

function text(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  if (typeof v !== 'string' || !v.trim()) throw new DriverError('BAD_REQUEST', `This scenario takes "${key}": text.`);
  return v;
}

const STEP_KEYS = new Set(['tool', 'args', 'status', 'gate', 'delayMs', 'error']);

/** Check one step from the wire. */
export function parseStep(v: unknown, i: number): Step {
  const where = `Step ${i + 1}`;
  if (!isRecord(v)) throw new DriverError('BAD_REQUEST', `${where} is an object: { tool, args?, status?, gate?, delayMs? } or { error: { status, message? }, gate?, delayMs? }.`);
  for (const k of Object.keys(v)) if (!STEP_KEYS.has(k)) throw new DriverError('BAD_REQUEST', `${where} does not take "${k}".`);
  if (v.gate !== undefined && (typeof v.gate !== 'string' || !/^[\w.-]{1,64}$/.test(v.gate))) throw new DriverError('BAD_REQUEST', `${where}: "gate" is a name of letters, digits, ".", "-" or "_".`);
  if (v.delayMs !== undefined && (!Number.isInteger(v.delayMs) || (v.delayMs as number) < 0 || (v.delayMs as number) > 60_000)) throw new DriverError('BAD_REQUEST', `${where}: "delayMs" is a whole number from 0 to 60000.`);
  const extra = { ...(v.gate !== undefined ? { gate: v.gate as string } : {}), ...(v.delayMs !== undefined ? { delayMs: v.delayMs as number } : {}) };
  if (v.error !== undefined) {
    if (v.tool !== undefined || v.args !== undefined || v.status !== undefined) throw new DriverError('BAD_REQUEST', `${where} is a tool call or an error, not both.`);
    const err = v.error;
    if (!isRecord(err) || !Number.isInteger(err.status) || (err.status as number) < 400 || (err.status as number) > 599) throw new DriverError('BAD_REQUEST', `${where}: "error" is { status: 400-599, message? }.`);
    if (err.message !== undefined && typeof err.message !== 'string') throw new DriverError('BAD_REQUEST', `${where}: the error's "message" is text.`);
    return { error: { status: err.status as number, ...(typeof err.message === 'string' ? { message: err.message } : {}) }, ...extra };
  }
  if (typeof v.tool !== 'string' || !/^[a-z][a-z0-9_.]{0,63}$/i.test(v.tool)) throw new DriverError('BAD_REQUEST', `${where} names its "tool" (such as "finish" or "request_clarification").`);
  if (v.args !== undefined && !isRecord(v.args)) throw new DriverError('BAD_REQUEST', `${where}: "args" is an object.`);
  if (v.status !== undefined && typeof v.status !== 'string') throw new DriverError('BAD_REQUEST', `${where}: "status" is text.`);
  return { tool: v.tool, ...(v.args !== undefined ? { args: v.args as Record<string, unknown> } : {}), ...(typeof v.status === 'string' ? { status: v.status } : {}), ...extra };
}

/** Read `assistant.script`'s arguments into the steps they ask for. */
export function parseScript(args: Record<string, unknown> | undefined): { steps: Step[]; mode: 'append' | 'replace'; scenario?: string } {
  const a = args ?? {};
  for (const k of Object.keys(a)) if (!['scenario', 'params', 'steps', 'mode'].includes(k)) throw new DriverError('BAD_REQUEST', `assistant.script does not take "${k}".`);
  if (a.mode !== undefined && a.mode !== 'append' && a.mode !== 'replace') throw new DriverError('BAD_REQUEST', '"mode" is "append" or "replace".');
  const mode = (a.mode as 'append' | 'replace' | undefined) ?? 'append';
  if ((a.scenario === undefined) === (a.steps === undefined)) throw new DriverError('BAD_REQUEST', `assistant.script takes a "scenario" (${Object.keys(SCENARIOS).join(', ')}) or "steps", one of them.`);
  if (a.scenario !== undefined) {
    if (typeof a.scenario !== 'string' || !Object.hasOwn(SCENARIOS, a.scenario)) throw new DriverError('BAD_REQUEST', `There is no scenario "${String(a.scenario)}"; there are ${Object.keys(SCENARIOS).join(', ')}.`, { details: { scenarios: Object.fromEntries(Object.entries(SCENARIOS).map(([k, s]) => [k, s.summary])) } });
    if (a.params !== undefined && !isRecord(a.params)) throw new DriverError('BAD_REQUEST', '"params" is an object.');
    const steps = SCENARIOS[a.scenario].steps((a.params as Record<string, unknown>) ?? {});
    return { steps: steps.map((s, i) => parseStep(s, i)), mode, scenario: a.scenario };
  }
  if (a.params !== undefined) throw new DriverError('BAD_REQUEST', '"params" goes with a "scenario".');
  if (!Array.isArray(a.steps) || !a.steps.length || a.steps.length > 100) throw new DriverError('BAD_REQUEST', '"steps" is a list of 1 to 100 steps.');
  return { steps: a.steps.map((s, i) => parseStep(s, i)), mode };
}

/** Every string a request sent, wherever it sits in the message format. */
function strings(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (isRecord(v)) return Object.values(v).flatMap(strings);
  return [];
}

/** The editor context the latest request carries, as the model reads it. */
export function requestContext(req: Pick<MockRequest, 'body'>): Record<string, unknown> | null {
  const said = strings(req.body?.messages).filter((t) => t.includes('<editor_context>')).at(-1);
  // The app appends the real one after the author's words, which may quote an example: the last block is the app's.
  const m = said ? [...said.matchAll(/<editor_context>\s*([\s\S]*?)\s*<\/editor_context>/g)].at(-1) : undefined;
  if (!m) return null;
  try {
    const ctx = JSON.parse(m[1]);
    return isRecord(ctx) ? ctx : null;
  } catch {
    return null;
  }
}

/** The latest tool result a request carries, parsed, with the tool it answered. */
export function latestResult(req: Pick<MockRequest, 'body'>): { tool: string; value: unknown } | null {
  const messages: unknown[] = Array.isArray(req.body?.messages) ? req.body.messages : [];
  // Only this request's own results: they come after its message (the one carrying the editor context). Anything
  // before it, an author's message that reads like a result included, is not one.
  const own = messages.map((m) => strings(m).some((t) => t.includes('<editor_context>'))).lastIndexOf(true);
  for (let i = messages.length - 1; i > own; i--) {
    const m = messages[i];
    if (!isRecord(m)) continue;
    const content = typeof m.content === 'string' ? m.content : null;
    // The constrained format sends a result as the user's words, "Result of <tool>:" and then the result.
    const r = content && /^(?:Result of|Error from) ([\w.]+):\n([\s\S]*)$/.exec(content);
    if (m.role === 'user' && r) {
      try {
        return { tool: r[1], value: JSON.parse(r[2]) };
      } catch {
        return { tool: r[1], value: r[2] };
      }
    }
    if (m.role === 'tool' && content !== null) {
      try {
        return { tool: str(m.name), value: JSON.parse(content) };
      } catch {
        return { tool: str(m.name), value: content };
      }
    }
  }
  return null;
}

/** A value at a dotted path ("selection.nodeId", "sections.0.id"), or undefined. */
export function pick(value: unknown, path: string): unknown {
  let v: unknown = value;
  for (const part of path.split('.')) {
    if (Array.isArray(v) && /^\d+$/.test(part)) v = v[Number(part)];
    else if (isRecord(v) && Object.hasOwn(v, part)) v = v[part];
    else return undefined;
  }
  return v;
}

/** Context paths a scenario may use for things the app names differently. */
const CONTEXT_ALIASES: Record<string, string[]> = { pageId: ['currentPage.id', 'page.id', 'pageId'] };

/**
 * A result's value at `path`: at that path, or else the one value found at it anywhere below (a result nests what it
 * returns). Several different values there are ambiguous: the step must name the one it means by its full path.
 */
function findIn(value: unknown, path: string, tool: string): unknown {
  const direct = pick(value, path);
  if (direct !== undefined) return direct;
  const found = new Map<string, unknown>();
  const walk = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    const here = pick(v, path);
    if (here !== undefined) found.set(JSON.stringify(here), here);
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x);
  };
  walk(value);
  if (found.size > 1) throw new Error(`the result of ${tool} has ${found.size} different values at ${path}: name one by its full path`);
  return found.values().next().value;
}

/**
 * Put what a request carries into a step's arguments: `{ "$context": path }` from its editor context and
 * `{ "$result": path }` from its latest tool result. A placeholder that finds nothing throws, saying which.
 */
export function resolveArgs(args: unknown, req: Pick<MockRequest, 'body'>): unknown {
  let ctx: Record<string, unknown> | null | undefined;
  let result: { tool: string; value: unknown } | null | undefined;
  const visit = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(visit);
    if (!isRecord(v)) return v;
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === '$context' && typeof v.$context === 'string') {
      ctx ??= requestContext(req);
      if (!ctx) throw new Error('the request carries no editor context');
      const paths = CONTEXT_ALIASES[v.$context] ?? [v.$context];
      for (const p of paths) {
        const found = pick(ctx, p);
        if (found !== undefined) return found;
      }
      throw new Error(`the editor context has no ${v.$context}`);
    }
    if (keys.length === 1 && keys[0] === '$result' && typeof v.$result === 'string') {
      result ??= latestResult(req);
      if (!result) throw new Error('the request carries no tool result');
      const found = findIn(result.value, v.$result, result.tool);
      if (found === undefined) throw new Error(`the result of ${result.tool} has no ${v.$result}`);
      return found;
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, visit(x)]));
  };
  return visit(args ?? {});
}

/** A step as the server sends it, for the request it answers. */
export function replyFor(step: Step, req: Pick<MockRequest, 'body'>): MockReply {
  if ('error' in step) return { status: step.error.status, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: { message: step.error.message ?? 'The scripted provider refused the request.' } }) };
  return envelopeReply(step.tool, resolveArgs(step.args, req), step.status ?? 'Working');
}

/** What the scripted provider has been told, and how far it got. */
export interface ScriptState {
  /** Steps not yet sent. */
  pending: number;
  /** Requests answered by a step. */
  answered: number;
  gates: Array<{ name: string; state: GateState }>;
  /** Steps that could not be sent as scripted (a placeholder that found nothing), newest last. */
  errors: Array<{ step: number; message: string }>;
}

/**
 * The script a scripted session plays: queued steps, each sent for the next model request, held at its gate until
 * released. Feeds a MockOpenAIServer through `responder()`.
 */
export class Script {
  private queue: Array<{ step: Step; n: number }> = [];
  private gates = new Map<string, { state: GateState; release: () => void; released: Promise<void> }>();
  /** Every gate name ever scripted: a release meant for one can never open a later one of the same name. */
  private used = new Set<string>();
  /** Delays under way, each ended early when the script closes. */
  private delays = new Set<{ timer: ReturnType<typeof setTimeout>; done: () => void }>();
  private count = 0;
  answered = 0;
  readonly errors: Array<{ step: number; message: string }> = [];
  private closed = false;

  /** Queue steps (or replace those waiting). A gate name already used is refused. */
  add(steps: Step[], mode: 'append' | 'replace' = 'append') {
    const names = steps.flatMap((s) => (s.gate ? [s.gate] : []));
    const dup = names.find((g, i) => names.indexOf(g) !== i || this.used.has(g));
    if (dup) throw new DriverError('BAD_REQUEST', `The gate "${dup}" is already used; each gate is named once in a session.`);
    for (const g of names) this.used.add(g);
    if (mode === 'replace') {
      for (const q of this.queue) if (q.step.gate) this.gates.delete(q.step.gate);
      this.queue = [];
    }
    for (const step of steps) {
      this.queue.push({ step, n: ++this.count });
      if (step.gate) {
        let release!: () => void;
        const released = new Promise<void>((r) => (release = r));
        this.gates.set(step.gate, { state: 'pending', release, released });
      }
    }
    return this.state();
  }

  /** Let a held reply go. Releasing one again changes nothing; one never scripted is TARGET_NOT_FOUND. */
  release(name: string) {
    const g = this.gates.get(name);
    if (!g) throw new DriverError('TARGET_NOT_FOUND', `No gate is named "${name}".`, { details: { gates: [...this.gates.keys()] } });
    g.state = 'released';
    g.release();
    return { gate: name, state: g.state };
  }

  state(): ScriptState {
    return { pending: this.queue.length, answered: this.answered, gates: [...this.gates.entries()].map(([name, g]) => ({ name, state: g.state })), errors: this.errors.slice(-20) };
  }

  /** The reply for the next request: the next step, resolved against the request, held at its gate. */
  next(req: MockRequest): MockReply {
    const item = this.queue.shift();
    // A 409: the adapter tries a 400 or 422 again in another request format, and retries a 5xx, and either retry would
    // take the next step meant for later. A 409 it reports as it is, with this message.
    if (!item) return { status: 409, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: { message: 'No scripted reply left' } }) };
    this.answered++;
    let reply: MockReply;
    try {
      reply = replyFor(item.step, req);
    } catch (e) {
      const message = `Step ${item.n} could not be sent: ${e instanceof Error ? e.message : String(e)}`;
      this.errors.push({ step: item.n, message });
      reply = { status: 409, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: { message } }) };
    }
    const gate = item.step.gate ? this.gates.get(item.step.gate) : undefined;
    if (gate && gate.state === 'pending') gate.state = 'reached';
    const waits = [gate?.released, item.step.delayMs ? this.delay(item.step.delayMs) : undefined].filter(Boolean);
    return waits.length ? { ...reply, hold: Promise.all(waits) } : reply;
  }

  private delay(ms: number): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((done) => {
      const d = { timer: setTimeout(() => (this.delays.delete(d), done()), ms), done };
      this.delays.add(d);
    });
  }

  /** Let every held reply go, end every delay and drop what is left (the session is closing). */
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const g of this.gates.values()) g.release();
    for (const d of this.delays) {
      clearTimeout(d.timer);
      d.done();
    }
    this.delays.clear();
    this.queue = [];
  }
}

// ---------------------------------------------------------------------------
// The journal, read in the app's main process
// ---------------------------------------------------------------------------

export type JournalCall = { op: 'read'; after: number; limit: number } | { op: 'limitTurns'; max: number | null; withinMs?: number } | { op: 'turns' };

/** Runs in the app's main process (app.evaluate): self-contained. */
export function journalInMain(_electron: unknown, call: JournalCall): any {
  const journal = (globalThis as any)[Symbol.for('siteorigin.aiJournal')];
  if (!journal) throw new Error('[not-installed] This build keeps no record of the assistant’s events: it predates them, or was not launched by a test. Rebuild it (npm run build).');
  if (call.op === 'read') return journal.read(call.after, call.limit);
  if (call.op === 'limitTurns') return journal.limitTurns(call.max, call.withinMs);
  return journal.turns();
}

// ---------------------------------------------------------------------------
// A real provider, by explicit opt-in
// ---------------------------------------------------------------------------

/** What `session.start` takes, with `provider: "configured"`, to let the assistant reach a real provider. */
export interface LiveArgs {
  provider: 'openai' | 'anthropic' | 'local';
  /** The model to ask; the app's default for the provider when left out. */
  model?: string;
  /** A local server's address (local only). */
  baseURL?: string;
  /** The most requests the assistant may start in the session (default 1, at most 5). */
  maxTurns?: number;
  /** How long the assistant may work, from the app being set up with the provider (default 120000, at most 900000). */
  timeoutMs?: number;
}

export const LIVE_LIMITS = { turns: { default: 1, max: 5 }, timeoutMs: { default: 120_000, max: 900_000 } };

/** The host environment variable that must say yes before a session may spend money. */
export const LIVE_OPT_IN = 'SITEORIGIN_DRIVER_LIVE';
const KEY_VARS = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' } as const;

/** Check `live`'s shape (what the request says). */
export function parseLive(v: unknown): LiveArgs {
  if (!isRecord(v)) throw new DriverError('BAD_REQUEST', '"live" is { provider: openai|anthropic|local, model?, baseURL?, maxTurns?, timeoutMs? }.');
  for (const k of Object.keys(v)) if (!['provider', 'model', 'baseURL', 'maxTurns', 'timeoutMs'].includes(k)) throw new DriverError('BAD_REQUEST', `"live" does not take "${k}".`);
  if (v.provider !== 'openai' && v.provider !== 'anthropic' && v.provider !== 'local') throw new DriverError('BAD_REQUEST', '"live.provider" is "openai", "anthropic" or "local".');
  if (v.model !== undefined && (typeof v.model !== 'string' || !v.model.trim() || v.model.length > 200)) throw new DriverError('BAD_REQUEST', '"live.model" is a model name.');
  if (v.baseURL !== undefined) {
    if (v.provider !== 'local') throw new DriverError('BAD_REQUEST', '"live.baseURL" is for a local server.');
    let ok = false;
    try {
      const u = typeof v.baseURL === 'string' ? new URL(v.baseURL) : null;
      // Nothing secret in an address: it is saved as it is, and Settings shows it in plain sight.
      ok = !!u && /^https?:$/.test(u.protocol) && !u.username && !u.password && !u.search && !u.hash;
    } catch {
      ok = false;
    }
    if (!ok) throw new DriverError('BAD_REQUEST', '"live.baseURL" is the server\'s http(s) address, with no credentials, query or fragment.');
  } else if (v.provider === 'local') throw new DriverError('BAD_REQUEST', 'A local server needs "live.baseURL".');
  if (v.maxTurns !== undefined && (!Number.isInteger(v.maxTurns) || (v.maxTurns as number) < 1 || (v.maxTurns as number) > LIVE_LIMITS.turns.max)) throw new DriverError('BAD_REQUEST', `"live.maxTurns" is a whole number from 1 to ${LIVE_LIMITS.turns.max}.`);
  if (v.timeoutMs !== undefined && (!Number.isInteger(v.timeoutMs) || (v.timeoutMs as number) < 1000 || (v.timeoutMs as number) > LIVE_LIMITS.timeoutMs.max)) throw new DriverError('BAD_REQUEST', `"live.timeoutMs" is a whole number of milliseconds from 1000 to ${LIVE_LIMITS.timeoutMs.max}.`);
  return v as unknown as LiveArgs;
}

export interface LiveSetup {
  provider: LiveArgs['provider'];
  model?: string;
  baseURL?: string;
  maxTurns: number;
  timeoutMs: number;
  /** The provider's key, from the host's environment; never part of anything the session reports. */
  key?: string;
}

/**
 * What a live session uses, from its `live` arguments and the host's own environment. Spending money takes two
 * decisions: the request asks for it, and the host environment says yes (SITEORIGIN_DRIVER_LIVE=1). The key comes
 * only from the host's environment, never from a request.
 */
export function liveSetup(live: LiveArgs, env: Record<string, string | undefined>): LiveSetup {
  if (env[LIVE_OPT_IN] !== '1') throw new DriverError('BAD_REQUEST', `A configured provider costs money: the driver's own environment must also set ${LIVE_OPT_IN}=1.`, { details: { reason: 'not-opted-in' } });
  const setup: LiveSetup = {
    provider: live.provider,
    ...(live.model ? { model: live.model } : {}),
    ...(live.baseURL ? { baseURL: live.baseURL } : {}),
    maxTurns: live.maxTurns ?? LIVE_LIMITS.turns.default,
    timeoutMs: live.timeoutMs ?? LIVE_LIMITS.timeoutMs.default
  };
  if (live.provider !== 'local') {
    const name = KEY_VARS[live.provider];
    const key = env[name]?.trim();
    if (!key) throw new DriverError('BAD_REQUEST', `A ${live.provider} session needs ${name} in the driver's environment.`, { details: { reason: 'no-key', variable: name } });
    setup.key = key;
  }
  return setup;
}

/** The settings a live session gives the app. */
export function liveSettings(s: LiveSetup): Record<string, unknown> {
  if (s.provider === 'local') return { ai: { provider: 'local', ...(s.model ? { models: { local: s.model } } : {}), local: { baseURL: s.baseURL, allowRemote: false } } };
  return { ai: { provider: s.provider, ...(s.model ? { models: { [s.provider]: s.model } } : {}) } };
}

// ---------------------------------------------------------------------------
// Reading the requests
// ---------------------------------------------------------------------------

const cursor = (v: unknown, name: string) => {
  if (v !== undefined && (!Number.isInteger(v) || (v as number) < 0)) throw new DriverError('BAD_REQUEST', `"${name}" is a cursor: a whole number from 0 (a reply's "next").`);
  return v as number | undefined;
};
const id = (v: unknown, name: string) => {
  if (v !== undefined && (typeof v !== 'string' || !v || v.length > 200)) throw new DriverError('BAD_REQUEST', `"${name}" is an ID from an observation.`);
  return v as string | undefined;
};

export function parseObserveArgs(args: Record<string, unknown> | undefined): { after?: number; limit?: number; runId?: string; conversationId?: string } {
  const a = args ?? {};
  for (const k of Object.keys(a)) if (!['after', 'limit', 'runId', 'conversationId'].includes(k)) throw new DriverError('BAD_REQUEST', `assistant.observe does not take "${k}".`);
  if (a.limit !== undefined && (!Number.isInteger(a.limit) || (a.limit as number) < 1 || (a.limit as number) > 1000)) throw new DriverError('BAD_REQUEST', '"limit" is a whole number from 1 to 1000.');
  const out = { after: cursor(a.after, 'after'), limit: a.limit as number | undefined, runId: id(a.runId, 'runId'), conversationId: id(a.conversationId, 'conversationId') };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

export function parseWaitArgs(args: Record<string, unknown> | undefined): { runId: string; after?: number } {
  const a = args ?? {};
  for (const k of Object.keys(a)) if (k !== 'runId' && k !== 'after') throw new DriverError('BAD_REQUEST', `assistant.wait does not take "${k}".`);
  const runId = id(a.runId, 'runId');
  if (!runId) throw new DriverError('BAD_REQUEST', 'assistant.wait names its "runId" (from a run.started entry): it waits for that run only.');
  const after = cursor(a.after, 'after');
  return after === undefined ? { runId } : { runId, after };
}

/** Whether the panel shows a run where it now stands: its question waiting, or its finished card. */
export function rendered(chat: ShownChat, run: RunView, reason: 'terminal' | 'input'): boolean {
  if (reason === 'input') return !!run.question && chat.question?.runId === run.runId && (!run.question.questionId || chat.question.questionId === run.question.questionId);
  return !!shownTurn(chat, run)?.reply.result;
}

/** Put a live session's key in the profile it made, readable only by this account (a new file, never one replaced). */
export async function writeLiveKey(profile: string, s: LiveSetup) {
  if (!s.key || s.provider === 'local') return;
  await writeFile(join(profile, 'api-keys.json'), JSON.stringify({ [s.provider]: s.key }), { mode: 0o600, flag: 'wx' });
}
