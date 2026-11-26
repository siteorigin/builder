/**
 * Where a frame inside the editor may go (src/main/index.ts): only to the preview the canvas shows. With no project
 * of this computer's open, that is the host's preview in a live session this app is a guest in (#766), for as long as
 * the guest is in it: a canvas would otherwise stay blank, every navigation to the guest's loopback server refused.
 */
import { describe, expect, it } from 'vitest';
import { canvasPreviewUrl, previewNavigationAllowed } from '../../src/main/player-frames';

const remote = (url: string | null) => ({ previewAccess: url ? { url } : null });

describe('the canvas’s preview', () => {
  it('is the open project’s preview server once it is ready', () => {
    expect(canvasPreviewUrl({ status: { state: 'ready', url: 'http://127.0.0.1:5173' } }, remote(null))).toBe('http://127.0.0.1:5173');
    expect(canvasPreviewUrl({ status: { state: 'starting' } }, remote(null))).toBeNull();
  });

  it('is the host’s preview, on this computer’s loopback server, while this app is a guest with no project open', () => {
    const shell = remote('http://127.0.0.1:4555');
    const url = canvasPreviewUrl(null, shell);
    expect(url).toBe('http://127.0.0.1:4555');
    expect(previewNavigationAllowed('http://127.0.0.1:4555/about/?tab=1', url)).toBe(true);
    // Another port on the same address is another server.
    expect(previewNavigationAllowed('http://127.0.0.1:45550/', url)).toBe(false);
    expect(previewNavigationAllowed('https://example.com/', url)).toBe(false);
    // Left: the same address is refused from then on.
    shell.previewAccess = null;
    expect(previewNavigationAllowed('http://127.0.0.1:4555/', canvasPreviewUrl(null, shell))).toBe(false);
  });

  it('always lets a frame go blank', () => {
    expect(previewNavigationAllowed('about:blank', null)).toBe(true);
  });
});
