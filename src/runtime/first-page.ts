/**
 * The benchmark's marks of the first page the preview answers a browser (scripts/perf/README.md): a frame or a window
 * loading it, never a request the app makes itself; when that request came, and when its answer had gone. A page whose
 * request is dropped before its answer goes (its frame replaced meanwhile) is not that page.
 *
 * The plugin is one of the preview server's whether marks are on or not, and watches requests only while they are:
 * Vite keys its dependency cache on the names of the server's plugins, so a plugin there only while marks are on had
 * every measured start bundle the project's dependencies again (a person's starts reuse what the last one bundled).
 * Kept apart from the worker so it can be tested.
 */
type Req = { method?: string; headers: Record<string, string | string[] | undefined> };
type Res = { once(e: 'finish', fn: () => void): unknown };
type Server = { middlewares: { use(fn: (req: Req, res: Res, next: () => void) => void): unknown } };

export const FIRST_PAGE_PLUGIN = 'siteorigin-perf-first-page';

/** `marked`: whether marks are on for this server; `report` is given the times, epoch ms, once. */
export function firstPagePlugin(marked: boolean, report: (asked: number, answered: number) => void) {
  let answered = false;
  const now = () => performance.timeOrigin + performance.now();
  return {
    name: FIRST_PAGE_PLUGIN,
    configureServer(server: Server) {
      if (!marked) return;
      server.middlewares.use((req, res, next) => {
        const dest = req.headers['sec-fetch-dest'];
        if (!answered && req.method === 'GET' && (dest === 'iframe' || dest === 'document') && String(req.headers.accept ?? '').includes('text/html')) {
          const asked = now();
          res.once('finish', () => {
            if (answered) return;
            answered = true;
            report(asked, now());
          });
        }
        next();
      });
    }
  };
}
