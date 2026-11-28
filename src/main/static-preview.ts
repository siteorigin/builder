import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, lstatSync, promises as fs, type BigIntStats } from 'node:fs';
import { extname, isAbsolute, join, normalize, relative } from 'node:path';
import { DOCUMENT_FORMATS } from '@shared/document-files';
import { statusPage } from '@shared/status-page';

/** The downloadable documents a site can link to, as the exported website's preview serves them. */
const documentTypes = Object.fromEntries(Object.entries(DOCUMENT_FORMATS).map(([ext, f]) => [`.${ext}`, f.mime]));

/**
 * Loopback previews of exported websites, one listener per export: a later export starts its own, so a proof still
 * open in a browser keeps serving its own files while the author compares it with the next one (issue 212). They all
 * belong to the project that exported them and stop together when it closes.
 */
export class StaticPreviews {
  private servers = new Map<string, Server>();
  /** Bumped by stopAll, so a listener still binding when the project closed is stopped instead of kept. */
  private generation = 0;

  /**
   * Serve an exported folder over loopback HTTP so it can be previewed as a real static site, under the
   * site's base path when it is published in a sub-folder.
   */
  async serve(root: string, base = ''): Promise<string> {
    const generation = this.generation;
    // The folder this export was written to. Whatever is at the path later (the folder moved away and another export,
    // or anything else, put there) is not this proof, and is never served under its address.
    const exported = await fs.stat(root, { bigint: true });
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.txt': 'text/plain', '.xml': 'application/xml', '.gif': 'image/gif', '.avif': 'image/avif', ...documentTypes, '.md': 'text/markdown; charset=utf-8', '.webmanifest': 'application/manifest+json' };
    const server = createServer(async (req, res) => {
      if (!(await sameFolder(root, exported))) {
        res.writeHead(410, PAGE_HEADERS);
        return res.end(MOVED);
      }
      try {
        const url = new URL(req.url ?? '/', 'http://x');
        const pathname = decodeURIComponent(url.pathname);
        if (base && (pathname === '/' || pathname === base)) {
          res.writeHead(301, { location: `${base}/${url.search}` });
          return res.end();
        }
        if (base && !pathname.startsWith(`${base}/`)) throw new Error('outside base');
        let p = base ? pathname.slice(base.length) : pathname;
        const realRoot = await fs.realpath(root);
        const contained = async (path: string) => {
          const real = await fs.realpath(normalize(join(root, path)));
          const rel = relative(realRoot, real);
          if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('denied');
          return real;
        };
        let real = await contained(p);
        if ((await fs.stat(real)).isDirectory()) {
          // Pages are folders with an index.html: "/about" redirects to "/about/" as static hosts do.
          if (!p.endsWith('/')) {
            res.writeHead(301, { location: `${url.pathname}/${url.search}` });
            return res.end();
          }
          p += 'index.html';
          real = await contained(p);
        }
        const data = await fs.readFile(real);
        // Its length said, as a static host says it: what a page check measures of each file is what was sent (#1488).
        res.writeHead(200, { 'content-type': types[extname(real).toLowerCase()] ?? 'application/octet-stream', 'content-length': data.length });
        res.end(data);
      } catch {
        const nfPath = join(root, '404.html');
        const nf = existsSync(nfPath) && !lstatSync(nfPath).isSymbolicLink() ? await fs.readFile(nfPath).catch(() => null) : null;
        if (nf) {
          res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
          return res.end(nf);
        }
        res.writeHead(404, PAGE_HEADERS);
        res.end(notFound(req.url ?? '/', base, existsSync(join(root, 'index.html'))));
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (generation !== this.generation) {
      stop(server);
      throw new Error('The project was closed before the preview started.');
    }
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${base}/`;
    this.servers.set(url, server);
    return url;
  }

  /** Stop one preview, e.g. one whose folder a newer export now occupies. */
  stop(url: string) {
    const server = this.servers.get(url);
    if (!server) return;
    this.servers.delete(url);
    stop(server);
  }

  /** Stop every preview, including any still starting. */
  stopAll() {
    this.generation++;
    for (const server of this.servers.values()) stop(server);
    this.servers.clear();
  }

  get size(): number {
    return this.servers.size;
  }
}

/**
 * The preview's own pages (src/shared/status-page.ts), for when it has nothing of the site's to show. Each says it is
 * the export preview speaking, so the fallback 404 is never taken for the site's own design.
 */
const PAGE_HEADERS = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
const BRAND = { label: 'Export preview' };

const MOVED = statusPage({
  title: 'Preview stopped',
  heading: 'This preview has stopped',
  text: 'This exported website is no longer in the folder it was saved to.',
  next: 'Open a current preview from the Export dialog in SiteOrigin Builder.',
  icon: 'unlink',
  tone: 'amber',
  brand: BRAND
});

/** A page the export does not have, when it has no 404.html of its own: with the way back to its home page. */
function notFound(requested: string, base: string, hasHome: boolean): string {
  let path = requested.split(/[?#]/)[0];
  try {
    path = decodeURIComponent(new URL(requested, 'http://x').pathname);
  } catch {
    // An address that does not parse, or is not valid UTF-8, is shown as it was asked for.
  }
  const home = `${base}/`;
  const atHome = path === home || path === base;
  return statusPage({
    title: 'Page not found',
    heading: 'Page not found',
    text: atHome ? 'This exported website has no home page.' : ['This exported website has no page at ', { code: path }, '.'],
    // Without a home page there is nowhere in the export to send the author, only back to the app.
    next: !hasHome ? 'Export the website again from SiteOrigin Builder, then open its preview.' : 'It has no 404 page of its own, so its preview shows this one.',
    action: hasHome && !atHome ? { label: 'Go to the home page', href: home } : undefined,
    icon: 'unlink',
    brand: BRAND
  });
}

/**
 * Is the folder at `root` still the one that was exported there? By file ID alone: the device number changes when a
 * drive or share is mounted again, and the same folder must keep its preview. A volume without file IDs reports 0 for
 * every folder, which leaves only the check that a folder is still there.
 */
const sameFolder = (root: string, exported: BigIntStats) => fs.stat(root, { bigint: true }).then((now) => now.isDirectory() && now.ino === exported.ino, () => false);

/** Close the listener and the connections a browser keeps open, so the port is released now. */
function stop(server: Server) {
  server.close();
  server.closeAllConnections();
}
