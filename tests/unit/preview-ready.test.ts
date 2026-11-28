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

describe('a page whose code component threw while it rendered (#1526)', () => {
  it('is served: the page is there, with the component’s note in its place', async () => {
    const page = '<title>Home</title><section>Hero</section><div data-so-render-error="Cannot read properties of undefined (reading \'nested\')" data-so-error-file="src/lib/Broken.svelte" data-so-editor-only>Broken</div>';
    const request = vi.fn().mockResolvedValue(new Response(page, { status: 500 }));
    await waitForPreviewPage('http://127.0.0.1:12345', '/', request, 0);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('is not the site’s error page, nor any other server error', async () => {
    const errorPage = vi.fn().mockResolvedValue(new Response('<title>Error 500</title><div data-so-render-error="x">x</div>', { status: 500 }));
    await expect(waitForPreviewPage('http://127.0.0.1:12345', '/', errorPage, 0)).rejects.toThrow('Preview error page');
    // The not-found page, its shared header's component having thrown: an address the preview does not have yet.
    const notFound = vi.fn().mockResolvedValue(new Response('<title>Page not found</title><div data-so-render-error="x">x</div><section class="so-not-found">', { status: 500 }));
    await expect(waitForPreviewPage('http://127.0.0.1:12345', '/', notFound, 0)).rejects.toThrow('HTTP 500');
    for (const status of [404, 503]) {
      const other = vi.fn().mockResolvedValue(new Response('<title>Home</title><div data-so-render-error="x">x</div>', { status }));
      await expect(waitForPreviewPage('http://127.0.0.1:12345', '/', other, 0)).rejects.toThrow(`HTTP ${status}`);
    }
    const mentioned = vi.fn().mockResolvedValue(new Response('<title>Home</title><p>data-so-render-error=</p>', { status: 500 }));
    await expect(waitForPreviewPage('http://127.0.0.1:12345', '/', mentioned, 0)).rejects.toThrow('HTTP 500');
  });
});
