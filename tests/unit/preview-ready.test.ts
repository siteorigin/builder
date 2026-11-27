import { describe, expect, it, vi } from 'vitest';
import { waitForPreviewPage } from '../../src/runtime/preview-ready';

describe('preview page readiness', () => {
  it('waits through a temporary server error before exposing the preview', async () => {
    const request = vi.fn().mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 })).mockResolvedValueOnce(new Response('<h1>Home</h1>', { status: 200 }));
    await waitForPreviewPage('http://127.0.0.1:12345', '/home/', request);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][0].href).toBe('http://127.0.0.1:12345/home/');
  });

  it('reports a page that never becomes available', async () => {
    const request = vi.fn().mockResolvedValue(new Response('Internal Server Error', { status: 500 }));
    await expect(waitForPreviewPage('http://127.0.0.1:12345', '/', request, 0)).rejects.toThrow('The preview could not serve /: HTTP 500');
  });

  it('waits past a preview error document served with HTTP 200', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(new Response('<title>Error 500</title><h1>Internal Error</h1>', { status: 200 }))
      .mockResolvedValueOnce(new Response('<title>Opening hours</title><h1>Opening hours</h1>', { status: 200 }));
    await waitForPreviewPage('http://127.0.0.1:12345', '/blog/opening-times/', request);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
