import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { FIRST_PAGE_PLUGIN, firstPagePlugin } from '../../src/runtime/first-page';

type Middleware = (req: { method?: string; headers: Record<string, string | undefined> }, res: EventEmitter, next: () => void) => void;

function serve(plugin: ReturnType<typeof firstPagePlugin>) {
  const used: Middleware[] = [];
  plugin.configureServer({ middlewares: { use: (fn: Middleware) => used.push(fn) } } as never);
  return used;
}

const page = (dest: string, accept = 'text/html,application/xhtml+xml') => ({ method: 'GET', headers: { 'sec-fetch-dest': dest, accept } });

describe('the preview’s first-page mark', () => {
  it('is the same plugin whether marks are on or not, so the dependency cache a person’s start wrote still applies', () => {
    // Vite keys its dependency cache on the server's plugin names: one there only while marks are on had every
    // measured start bundle the dependencies again.
    expect(firstPagePlugin(false, () => {}).name).toBe(FIRST_PAGE_PLUGIN);
    expect(firstPagePlugin(true, () => {}).name).toBe(FIRST_PAGE_PLUGIN);
  });

  it('watches no request while marks are off', () => {
    expect(serve(firstPagePlugin(false, () => {}))).toHaveLength(0);
  });

  it('reports the first page a frame loads once its answer has gone, and nothing after it', () => {
    const reports: Array<[number, number]> = [];
    const [middleware] = serve(firstPagePlugin(true, (asked, answered) => reports.push([asked, answered])));
    const next = () => {};
    // A module, and a page the app fetches itself, are not a page a frame loads.
    const script = new EventEmitter();
    middleware({ method: 'GET', headers: { 'sec-fetch-dest': 'script', accept: '*/*' } }, script, next);
    script.emit('finish');
    const fetched = new EventEmitter();
    middleware(page('empty'), fetched, next);
    fetched.emit('finish');
    expect(reports).toHaveLength(0);
    const first = new EventEmitter();
    middleware(page('iframe'), first, next);
    expect(reports).toHaveLength(0);
    first.emit('finish');
    expect(reports).toHaveLength(1);
    expect(reports[0][1]).toBeGreaterThanOrEqual(reports[0][0]);
    const second = new EventEmitter();
    middleware(page('document'), second, next);
    second.emit('finish');
    expect(reports).toHaveLength(1);
  });
});
