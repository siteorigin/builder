/**
 * The main process's ledger of form routing grants (#1129): a grant is a token it made up for one review, good once,
 * at that review's revision, for that batch, making exactly its changes, and landing it as the user was shown it.
 */
import { describe, expect, it } from 'vitest';
import type { FormRoutingChange } from '@engine/form-routing';
import type { ProjectState } from '@shared/types';
import { admits, FormRoutingGrants, reviewed, type Candidate } from '../../src/main/project/form-routing-grants';

const change = (key: string): FormRoutingChange => ({ kind: 'setting', definitionId: 'form', name: 'Form', key });
const base = {} as ProjectState;
const candidate = (): Candidate => ({ base, state: {} as ProjectState, results: [] });

describe('form routing grants', () => {
  it('admits only the batch, revision, run and changes the review named, each exactly', () => {
    const ledger = new FormRoutingGrants();
    const both = [change('a'), change('b')];
    const take = () => ledger.take(ledger.grant(ledger.review(3, 'run', 'ops', both, candidate()).id, 3, 'run'));
    expect(admits(take(), 3, 'run', 'ops', both)).toBe(true);
    expect(admits(take(), 3, 'run', 'ops', [change('b'), change('a'), change('a')])).toBe(true);
    // Fewer changes, more changes, other changes, another batch, revision or run: none of them was what the user saw.
    expect(admits(take(), 3, 'run', 'ops', [change('a')])).toBe(false);
    expect(admits(take(), 3, 'run', 'ops', [...both, change('c')])).toBe(false);
    expect(admits(take(), 3, 'run', 'ops', [change('a'), change('c')])).toBe(false);
    expect(admits(take(), 3, 'run', 'other', both)).toBe(false);
    expect(admits(take(), 4, 'run', 'ops', both)).toBe(false);
    expect(admits(take(), 3, 'another run', 'ops', both)).toBe(false);
    expect(admits(take(), 3, null, 'ops', both)).toBe(false);
    expect(admits(null, 3, 'run', 'ops', both)).toBe(false);
  });

  it('gives a grant once per review, takes each once, and only at the review’s revision and run', () => {
    const ledger = new FormRoutingGrants();
    const review = ledger.review(1, null, 'ops', [change('a')], candidate());
    expect(ledger.grant(review.id, 2, null)).toBeNull();
    expect(ledger.grant(review.id, 1, null)).toBeNull();
    expect(ledger.grant(ledger.review(1, 'run_1', 'ops', [change('a')], candidate()).id, 1, 'run_2')).toBeNull();
    expect(ledger.grant('not-a-review', 1, null)).toBeNull();
    const again = ledger.review(1, null, 'ops', [change('a')], candidate());
    const grant = ledger.grant(again.id, 1, null)!;
    expect(grant.token).toMatch(/^[0-9a-f]{64}$/);
    expect(grant.token).not.toBe(again.id);
    expect(ledger.take({ token: again.id })).toBeNull();
    expect(ledger.take({ token: 'f'.repeat(64) })).toBeNull();
    expect(ledger.take({ operations: 'ops', changes: ['a'] })).toBeNull();
    expect(new FormRoutingGrants().take(grant)).toBeNull();
    // A forged token tried while a real grant waits leaves the real one good.
    expect(ledger.take(grant)).not.toBeNull();
    expect(ledger.take(grant)).toBeNull();
  });

  it('grants each review its own token, which allows only that review', () => {
    const ledger = new FormRoutingGrants();
    const first = ledger.review(1, null, 'one', [change('a')], candidate());
    const second = ledger.review(1, null, 'two', [change('b')], candidate());
    const a = ledger.grant(first.id, 1, null)!;
    const b = ledger.grant(second.id, 1, null)!;
    expect(a.token).not.toBe(b.token);
    expect(admits(ledger.take(a), 1, null, 'two', [change('b')])).toBe(false);
    expect(admits(ledger.take(b), 1, null, 'two', [change('b')])).toBe(true);
  });

  it('lands the batch as it was refused only from the same project, batch, revision and run', () => {
    const ledger = new FormRoutingGrants();
    const made = candidate();
    const take = () => ledger.take(ledger.grant(ledger.review(1, 'run', 'ops', [change('a')], made).id, 1, 'run'));
    expect(reviewed(take(), base, 1, 'run', 'ops')).toBe(made);
    expect(reviewed(take(), {} as ProjectState, 1, 'run', 'ops')).toBeNull();
    expect(reviewed(take(), base, 2, 'run', 'ops')).toBeNull();
    expect(reviewed(take(), base, 1, 'other', 'ops')).toBeNull();
    expect(reviewed(take(), base, 1, 'run', 'other')).toBeNull();
    expect(reviewed(null, base, 1, 'run', 'ops')).toBeNull();
  });

  it('shows a review that shares nothing with what the batch lands as', () => {
    const value = [{ id: 'item_1', inbox: 'a@example.com' }];
    const shown = new FormRoutingGrants().review(1, null, 'ops', [{ ...change('a'), value }], candidate());
    (shown.changes[0].value as typeof value)[0].id = 'item_2';
    expect(value[0].id).toBe('item_1');
  });

  it('forgets what was filed at another revision, and keeps what waits at this one', () => {
    const ledger = new FormRoutingGrants();
    const grant = ledger.grant(ledger.review(1, null, 'ops', [change('a')], candidate()).id, 1, null)!;
    const waiting = ledger.review(1, null, 'ops', [change('b')], candidate());
    const kept = ledger.review(2, null, 'ops', [change('c')], candidate());
    ledger.review(2, null, 'ops', [change('d')], candidate());
    expect(ledger.take(grant)).toBeNull();
    expect(ledger.grant(waiting.id, 1, null)).toBeNull();
    expect(ledger.grant(kept.id, 2, null)).not.toBeNull();
  });
});
