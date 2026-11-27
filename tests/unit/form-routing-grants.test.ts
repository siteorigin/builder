/**
 * The main process's ledger of form routing grants (#1129): a grant is a token it made up for one review, good once,
 * at that review's revision, for that batch, making exactly its changes.
 */
import { describe, expect, it } from 'vitest';
import type { FormRoutingChange } from '@engine/form-routing';
import { admits, FormRoutingGrants } from '../../src/main/project/form-routing-grants';

const change = (key: string): FormRoutingChange => ({ kind: 'setting', definitionId: 'form', name: 'Form', key });

describe('form routing grants', () => {
  it('admits only the batch, revision and changes the review named, each exactly', () => {
    const ledger = new FormRoutingGrants();
    const both = [change('a'), change('b')];
    const take = () => ledger.take(ledger.grant(ledger.review(3, 'ops', both).id, 3));
    expect(admits(take(), 3, 'ops', both)).toBe(true);
    expect(admits(take(), 3, 'ops', [change('b'), change('a')])).toBe(true);
    // Fewer changes, more changes, other changes, another batch or another revision: none of them was what the user saw.
    expect(admits(take(), 3, 'ops', [change('a')])).toBe(false);
    expect(admits(take(), 3, 'ops', [...both, change('c')])).toBe(false);
    expect(admits(take(), 3, 'ops', [change('a'), change('c')])).toBe(false);
    expect(admits(take(), 3, 'other', both)).toBe(false);
    expect(admits(take(), 4, 'ops', both)).toBe(false);
    expect(admits(null, 3, 'ops', both)).toBe(false);
  });

  it('gives a grant once per review, takes each once, and only at the review’s revision', () => {
    const ledger = new FormRoutingGrants();
    const review = ledger.review(1, 'ops', [change('a')]);
    expect(ledger.grant(review.id, 2)).toBeNull();
    expect(ledger.grant(review.id, 1)).toBeNull();
    const again = ledger.review(1, 'ops', [change('a')]);
    const grant = ledger.grant(again.id, 1)!;
    expect(grant.token).toMatch(/^[0-9a-f]{64}$/);
    expect(grant.token).not.toBe(again.id);
    expect(ledger.take(grant)).not.toBeNull();
    expect(ledger.take(grant)).toBeNull();
    expect(ledger.take({ token: again.id })).toBeNull();
    expect(ledger.take({ operations: 'ops', changes: ['a'] })).toBeNull();
  });

  it('forgets what was filed at another revision', () => {
    const ledger = new FormRoutingGrants();
    const grant = ledger.grant(ledger.review(1, 'ops', [change('a')]).id, 1)!;
    const waiting = ledger.review(1, 'ops', [change('b')]);
    ledger.review(2, 'ops', [change('c')]);
    expect(ledger.take(grant)).toBeNull();
    expect(ledger.grant(waiting.id, 1)).toBeNull();
  });
});
