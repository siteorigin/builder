/**
 * The main process's record of what the user allowed of an AI batch that changes where a contact form sends (#1129).
 * A refusal at commit files what the batch would change as a review; only the app, once the user allows it when asked
 * (agent/orchestrator.ts), turns that review into a grant. A grant is a token the session made up, good once, at the
 * revision the batch was refused at, for exactly the batch it was refused for and exactly the changes the user was
 * shown: each placement it reaches, and each setting's value whole (engine/form-routing keys). Nothing a model writes,
 * a reply says or a page holds can make one: no value of a review, or of the batch, is a grant.
 */
import { randomBytes } from 'node:crypto';
import type { FormRoutingChange, FormRoutingGrant, FormRoutingReview } from '@engine/form-routing';

interface Filed {
  revision: number;
  /** The batch, as session.apply fingerprints it. */
  operations: string;
  /** Its changes' keys, sorted. */
  keys: string[];
}

/** Reviews and grants kept at once: a run asks about one batch at a time, so only a handful ever wait. */
const KEPT = 8;

const keysOf = (changes: readonly FormRoutingChange[]) => [...new Set(changes.map((c) => c.key))].sort();
const token = () => randomBytes(32).toString('hex');

export class FormRoutingGrants {
  private reviews = new Map<string, Filed>();
  private grants = new Map<string, Filed>();

  /** Files a refused batch's changes, at `revision`, as a review the app may ask the user about. */
  review(revision: number, operations: string, changes: FormRoutingChange[]): FormRoutingReview {
    this.forget(revision);
    const id = token();
    this.reviews.set(id, { revision, operations, keys: keysOf(changes) });
    trim(this.reviews);
    return { id, operations, changes };
  }

  /**
   * The grant for a review the user allowed, or null when there is none to give: a review this session never filed,
   * one already granted, or one filed at a revision the project has moved on from. The review is used up either way.
   */
  grant(reviewId: string, revision: number): FormRoutingGrant | null {
    const filed = typeof reviewId === 'string' ? this.reviews.get(reviewId) : undefined;
    if (!filed) return null;
    this.reviews.delete(reviewId);
    if (filed.revision !== revision) return null;
    const t = token();
    this.grants.set(t, filed);
    trim(this.grants);
    return { token: t };
  }

  /**
   * Takes `grant` out of the ledger, so it is good for one batch at most: what it allows, or null when it is not one
   * this session gave (whatever it looks like) or was already used.
   */
  take(grant: unknown): Filed | null {
    const t = grant && typeof grant === 'object' ? (grant as { token?: unknown }).token : undefined;
    if (typeof t !== 'string' || !this.grants.has(t)) return null;
    const filed = this.grants.get(t)!;
    this.grants.delete(t);
    return filed;
  }

  /** Lets go of everything filed at a revision other than `revision`: none of it can be granted or used again. */
  forget(revision: number): void {
    for (const map of [this.reviews, this.grants]) for (const [k, f] of map) if (f.revision !== revision) map.delete(k);
  }
}

/** Whether a grant taken from the ledger allows a batch: the same batch, at the same revision, making exactly the changes it was given for. */
export function admits(filed: Filed | null, revision: number, operations: string, changes: readonly FormRoutingChange[]): boolean {
  if (!changes.length) return true;
  if (!filed || filed.revision !== revision || filed.operations !== operations) return false;
  const keys = keysOf(changes);
  return keys.length === filed.keys.length && keys.every((k, i) => k === filed.keys[i]);
}

function trim(map: Map<string, Filed>): void {
  while (map.size > KEPT) map.delete(map.keys().next().value!);
}
