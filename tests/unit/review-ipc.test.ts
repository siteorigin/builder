/**
 * The client review's calls (#1134) reach the main process on their own channels: each method the preload offers
 * invokes the channel named for it, and the main process handles that channel. The Export dialog's tests stand in for
 * the bridge, so a method wired to another channel would pass them all.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const preload = readFileSync('src/preload/index.ts', 'utf8');
const main = readFileSync('src/main/index.ts', 'utf8');

describe('the client review’s IPC', () => {
  it.each([
    ['reviewEditions', 'controller.reviewEditions()'],
    ['captureReviewEdition', 'controller.captureReviewEdition('],
    ['exportReviewSheet', 'controller.exportReviewSheet(']
  ])('project.%s invokes project:%s, which the main process hands to the controller', (method, call) => {
    expect(preload).toContain(`    ${method}: invoke('project:${method}'),`);
    const at = main.indexOf(`handle('project:${method}'`);
    expect(at).toBeGreaterThan(-1);
    expect(main.indexOf(`handle('project:${method}'`, at + 1)).toBe(-1);
    // The handler's own body calls the controller method of the same name.
    const body = main.slice(at, main.indexOf('handle(', at + 1));
    expect(body).toContain(call);
  });
});
