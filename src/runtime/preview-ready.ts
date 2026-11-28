/** A code placement's note that it threw while the page rendered (see renderErrorBoundary in the generator). */
const RENDER_ERROR_NOTE = /<div data-so-render-error="/;
/** The site's not-found page (generateNotFound): an address the site does not have yet, whatever else it shows. */
const NOT_FOUND_PAGE = /<section class="so-not-found"/;

/** Wait until Vite can serve the generated home page, not merely accept connections. */
export async function waitForPreviewPage(
  address: string,
  route: string,
  request: typeof fetch = fetch,
  timeoutMs = 20_000
): Promise<void> {
  const url = new URL(route, address);
  const deadline = Date.now() + timeoutMs;
  let last = 'No response';
  do {
    try {
      const response = await request(url, { headers: { accept: 'text/html' }, signal: AbortSignal.timeout(5000) });
      const html = await response.text();
      const errorPage = /<title>\s*Error (?:404|500)\s*<\/title>/i.test(html);
      // A page whose code component threw while it rendered is served, with that component's note in its place, as a
      // 500 (#1526): the page is there, and the editor shows it to say what went wrong. The not-found page with a note
      // (its shared header's component threw) is still an address the preview does not have yet.
      const rendered = response.status === 500 && RENDER_ERROR_NOTE.test(html) && !NOT_FOUND_PAGE.test(html);
      if ((response.ok || rendered) && !errorPage) return;
      last = errorPage ? 'Preview error page' : `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (true);
  throw new Error(`The preview could not serve ${route}: ${last}`);
}
