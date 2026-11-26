import { describe, expect, it } from 'vitest';
import { LIVE_GUEST_HEADER, liveGuestPlugin, proxiedByVite } from '../../src/runtime/policy';

/**
 * A live session guest is shown the project's site and nothing more: the preview server refuses a guest's request
 * that the project's own `server.proxy` would pass on to another server, by Vite's own rule for matching it.
 */

type Middleware = (req: { headers: Record<string, string | undefined>; url?: string }, res: { statusCode: number; setHeader(name: string, value: string): unknown; end(body?: string): unknown }, next: () => void) => void;

function served(proxy: Record<string, unknown> | undefined) {
  const uses: Middleware[] = [];
  liveGuestPlugin().configureServer({ config: { server: { proxy } }, middlewares: { use: (fn) => uses.push(fn as Middleware) } });
  /** What one request gets: passed on to Vite (`next`), or refused with its status. */
  const ask = (url: string, guest: boolean) => {
    let passed = false;
    const res = { statusCode: 200, headers: {} as Record<string, string>, body: '', setHeader: (n: string, v: string) => (res.headers[n] = v), end: (b?: string) => (res.body = b ?? '') };
    for (const fn of uses) fn({ url, headers: guest ? { [LIVE_GUEST_HEADER]: '1' } : {} }, res, () => (passed = true));
    return uses.length === 0 || passed ? 'passed' : res.statusCode;
  };
  return { uses, ask };
}

describe('the live guest guard', () => {
  it('matches a context as Vite does: a ^ pattern, or a prefix', () => {
    expect(proxiedByVite(['/api'], '/api/users')).toBe(true);
    expect(proxiedByVite(['/api'], '/apiary')).toBe(true);
    expect(proxiedByVite(['/api'], '/about/')).toBe(false);
    expect(proxiedByVite(['^/fallback/.*'], '/fallback/x')).toBe(true);
    expect(proxiedByVite(['^/fallback/.*'], '/x/fallback/')).toBe(false);
    // A pattern that cannot be read is refused, not guessed at.
    expect(proxiedByVite(['^/(unclosed'], '/anything')).toBe(true);
  });

  it('refuses a guest anything the project’s proxy would pass on, and leaves everything else alone', () => {
    const { ask } = served({ '/api': 'http://localhost:3000', '^/legacy/.*': { target: 'https://old.example' }, '/off': undefined });
    expect(ask('/api/orders', true)).toBe(404);
    expect(ask('/legacy/page', true)).toBe(404);
    // The editor's own preview is not a guest's.
    expect(ask('/api/orders', false)).toBe('passed');
    // The site itself, and a rule the project switched off.
    expect(ask('/', true)).toBe('passed');
    expect(ask('/off/x', true)).toBe('passed');
  });

  it('adds nothing for a project with no proxy rules', () => {
    expect(served(undefined).uses).toEqual([]);
    expect(served({}).uses).toEqual([]);
  });
});
