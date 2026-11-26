/**
 * The assistant's events in automated runs (#495): every AiEvent the orchestrator sends the editor, numbered in the
 * order it was sent, so a test can follow each run by its own IDs however the editor shows it (a hidden panel, another
 * conversation on screen, a reloaded or replaced window, a project closed and opened again).
 *
 * Installed only in automated runs, and reachable only from the main process itself (a test's app.evaluate), under
 * AI_JOURNAL on globalThis, as headless-desktop.ts is. Nothing is added to IPC, the preload API or the network, and a
 * normal launch records nothing.
 *
 * Bounded by count and by size: the oldest events go first, and a reader asking from before them is told how many it
 * missed rather than given a gap it cannot see.
 *
 * A run's streamed text is sent as the pieces it gains (AiEvent `at`); the journal keeps it whole, each text record
 * holding the turn's text so far, so only the latest of a run's text events in a row is kept: it holds everything the
 * earlier ones did.
 *
 * A test that lets the assistant reach a real provider also caps how many requests it may start and until when
 * (`limitTurns`): the main process asks `admit()` before anything reaches a provider, so one past the cap or the
 * deadline never does, and at the deadline the journal stops what is running itself (`onSpent`), whatever the test
 * or the editor window is doing then.
 */

/** Where the installed journal is found on the main process's globalThis. */
export const AI_JOURNAL = Symbol.for('siteorigin.aiJournal');

export interface JournalRecord {
  /** From 1, in the order the events were sent. */
  seq: number;
  /** When it was sent (ms since the epoch). */
  at: number;
  /** The event as the editor received it. */
  event: unknown;
}

export interface JournalPage {
  records: JournalRecord[];
  /** The latest seq read: pass it as `after` to read on. */
  next: number;
  /** The seq of the oldest record still kept (latest + 1 when none are). */
  oldest: number;
  /** The newest seq recorded. */
  latest: number;
  /** Records after `after` that were dropped before they could be read. */
  missed: number;
}

export interface AiJournalOptions {
  maxRecords?: number;
  maxBytes?: number;
  now?: () => number;
}

export class AiJournal {
  private records: Array<{ seq: number; at: number; json: string; bytes: number; text?: string }> = [];
  /** Seqs whose streamed text a later record replaced (ascending): not missed by a reader, since the later one holds it. */
  private superseded: number[] = [];
  private bytes = 0;
  private seq = 0;
  private readonly maxRecords: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private turnLimit: number | null = null;
  private turnsUsed = 0;
  private deadline: number | null = null;
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private spent = false;
  private stopAll: (() => void) | null = null;
  /** The streamed text of the latest run's turn, whole, which the next piece of it is added to. */
  private streamed: { key: string; text: string } | null = null;

  constructor(opts: AiJournalOptions = {}) {
    this.maxRecords = opts.maxRecords ?? 5000;
    this.maxBytes = opts.maxBytes ?? 16 * 1024 * 1024;
    this.now = opts.now ?? Date.now;
  }

  /** Keep one event, as sent. Never throws: an event that cannot be kept is recorded as such, keeping the order. */
  record(event: unknown) {
    event = this.whole(event);
    let json: string;
    try {
      json = JSON.stringify(event) ?? 'null';
    } catch {
      json = JSON.stringify({ unreadable: true });
    }
    const e = event as { kind?: unknown; runId?: unknown; conversationId?: unknown } | null;
    // A run's text, sent whole each time it grows: the latest replaces the one just before it.
    const text = e && e.kind === 'text' && typeof e.runId === 'string' ? `${e.runId}|${String(e.conversationId)}` : undefined;
    const last = this.records.at(-1);
    if (text && last?.text === text) {
      const gone = this.records.pop()!;
      this.bytes -= gone.bytes;
      this.superseded.push(gone.seq);
      if (this.superseded.length > 100_000) this.superseded.splice(0, this.superseded.length - 100_000);
    }
    const bytes = Buffer.byteLength(json);
    this.records.push({ seq: ++this.seq, at: this.now(), json, bytes, ...(text ? { text } : {}) });
    this.bytes += bytes;
    while (this.records.length > 1 && (this.records.length > this.maxRecords || this.bytes > this.maxBytes)) this.bytes -= this.records.shift()!.bytes;
  }

  /**
   * The event with its turn's text whole: a streamed piece is added to the text before it (the last text event of its
   * run, or the run's message as last sent), as the editor adds it.
   */
  private whole(event: unknown): unknown {
    const e = event as { kind?: unknown; runId?: unknown; conversationId?: unknown; text?: unknown; at?: unknown; message?: { role?: unknown; text?: unknown } } | null;
    if (!e || typeof e !== 'object' || typeof e.runId !== 'string') return event;
    const key = `${e.runId}|${String(e.conversationId)}`;
    if (e.kind === 'message' && e.message?.role === 'assistant' && typeof e.message.text === 'string') this.streamed = { key, text: e.message.text };
    if (e.kind !== 'text' || typeof e.text !== 'string') return event;
    const before = this.streamed?.key === key ? this.streamed.text : '';
    const text = typeof e.at === 'number' ? before.slice(0, e.at) + e.text : e.text;
    this.streamed = { key, text };
    if (typeof e.at !== 'number') return event;
    const { at: _at, ...rest } = e;
    return { ...rest, text };
  }

  /** What stops the assistant (its running request and any code fix) when a deadline passes. */
  onSpent(stop: () => void) {
    this.stopAll = stop;
  }

  /**
   * Cap the requests the assistant may start, counting those it has (null: no cap), and optionally the time it may work
   * for (`withinMs` from now): once it passes, nothing more is admitted and what is running is stopped.
   */
  limitTurns(max: number | null, withinMs?: number) {
    this.turnLimit = max === null ? null : Math.max(0, Math.floor(max));
    if (withinMs !== undefined) {
      if (this.deadlineTimer) clearTimeout(this.deadlineTimer);
      this.deadline = this.now() + Math.max(0, withinMs);
      this.deadlineTimer = setTimeout(() => this.spend(), Math.max(0, withinMs));
      // A test's deadline never keeps the app running.
      (this.deadlineTimer as { unref?: () => void }).unref?.();
    }
    return this.turns();
  }

  /** How many requests have been admitted, the cap and deadline, and whether the deadline has passed. */
  turns(): { used: number; limit: number | null; deadline: number | null; spent: boolean } {
    return { used: this.turnsUsed, limit: this.turnLimit, deadline: this.deadline, spent: this.spent || (this.deadline !== null && this.now() >= this.deadline) };
  }

  /** Take one request's turn, or refuse it when the cap is reached or the deadline has passed. */
  admit(): boolean {
    if (this.turns().spent) return false;
    if (this.turnLimit !== null && this.turnsUsed >= this.turnLimit) return false;
    this.turnsUsed++;
    return true;
  }

  /** The deadline passed: admit nothing more, and stop what is running. */
  private spend() {
    this.spent = true;
    this.deadlineTimer = null;
    try {
      this.stopAll?.();
    } catch {
      // Stopping is best effort; nothing more is admitted either way.
    }
  }

  /** Give back the turn of a request that was refused before it started. */
  giveBack() {
    if (this.turnsUsed > 0) this.turnsUsed--;
  }

  /** The records after `after`, oldest first, at most `limit`. */
  read(after = 0, limit = 500): JournalPage {
    const oldest = this.records[0]?.seq ?? this.seq + 1;
    const from = Math.max(after, 0);
    // Events between the cursor and the oldest kept that were let go, not those replaced by later text.
    const replaced = this.superseded.filter((x) => x > from && x < oldest).length;
    const missed = Math.max(0, oldest - from - 1 - replaced);
    const records: JournalRecord[] = [];
    for (const r of this.records) {
      if (r.seq <= from) continue;
      if (records.length >= limit) break;
      records.push({ seq: r.seq, at: r.at, event: JSON.parse(r.json) });
    }
    return { records, next: records.at(-1)?.seq ?? Math.max(from, oldest - 1), oldest, latest: this.seq, missed };
  }
}

/** Publish a journal on `global`: call it only in an automated run. */
export function installAiJournal(global: object, opts: AiJournalOptions = {}): AiJournal {
  const journal = new AiJournal(opts);
  (global as Record<symbol, unknown>)[AI_JOURNAL] = journal;
  return journal;
}
