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
 * A test that lets the assistant reach a real provider also caps how many requests it may start (`limitTurns`): the
 * main process asks `admit()` before a request reaches the orchestrator, so one past the cap never reaches a model.
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
  private records: Array<{ seq: number; at: number; json: string }> = [];
  private bytes = 0;
  private seq = 0;
  private readonly maxRecords: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private turnLimit: number | null = null;
  private turnsUsed = 0;

  constructor(opts: AiJournalOptions = {}) {
    this.maxRecords = opts.maxRecords ?? 5000;
    this.maxBytes = opts.maxBytes ?? 16 * 1024 * 1024;
    this.now = opts.now ?? Date.now;
  }

  /** Keep one event, as sent. Never throws: an event that cannot be kept is recorded as such, keeping the order. */
  record(event: unknown) {
    let json: string;
    try {
      json = JSON.stringify(event) ?? 'null';
    } catch {
      json = JSON.stringify({ unreadable: true });
    }
    this.records.push({ seq: ++this.seq, at: this.now(), json });
    this.bytes += json.length;
    while (this.records.length > 1 && (this.records.length > this.maxRecords || this.bytes > this.maxBytes)) this.bytes -= this.records.shift()!.json.length;
  }

  /** Cap the requests the assistant may start from now on, counting those it has (null: no cap). */
  limitTurns(max: number | null) {
    this.turnLimit = max === null ? null : Math.max(0, Math.floor(max));
    return this.turns();
  }

  /** How many requests have been admitted, and the cap. */
  turns(): { used: number; limit: number | null } {
    return { used: this.turnsUsed, limit: this.turnLimit };
  }

  /** Take one request's turn, or refuse it when the cap is reached. */
  admit(): boolean {
    if (this.turnLimit !== null && this.turnsUsed >= this.turnLimit) return false;
    this.turnsUsed++;
    return true;
  }

  /** Give back the turn of a request that was refused before it started. */
  giveBack() {
    if (this.turnsUsed > 0) this.turnsUsed--;
  }

  /** The records after `after`, oldest first, at most `limit`. */
  read(after = 0, limit = 500): JournalPage {
    const oldest = this.records[0]?.seq ?? this.seq + 1;
    const from = Math.max(after, 0);
    const missed = Math.max(0, oldest - from - 1);
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
