/**
 * Keeps the page being edited through a change to the project's src/app.html that only names another language or
 * direction. SvelteKit reloads every open page when its app template changes, since Vite on its own reloads only a page
 * whose own HTML file changed. The site's language and direction are what a project's state puts in src/app.html
 * (generateAppHtml), and the editor's preview applies those to the open page in place (the instrumented root layout,
 * generateLayout), so a reload for them would only cost the author their place on the page, their selection and the
 * text they were in. Any other change to the file (one made by hand, say) reloads the page as before. The next page
 * load reads the file as it is now.
 *
 * Kept apart from the dev plugin so it can be tested without a dev server.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { HTML_ATTR, HTML_START } from '@shared/languages';

type Emit = (event: string | symbol, ...args: unknown[]) => boolean;
type Hot = { send: (...args: unknown[]) => void };

/** What this uses of a Vite dev server. */
export type TemplateServer = {
  watcher?: { emit: Emit };
  ws?: Hot;
  environments?: Record<string, { hot?: Hot } | undefined>;
};

/** A path as the watcher may report it: either slash, so a Windows path matches however it is spelled. */
const same = (path: string) => path.replace(/\\/g, '/');

/**
 * The template without the language and direction its opening <html> tag declares: what else it says. Only those two
 * attributes of that tag go, read as attributes (a value that merely mentions lang= stays as it is).
 */
export function templateBesidesLanguage(html: string): string {
  return html.replace(HTML_START, (_, before: string, tag: string, attrs: string, end: string) => {
    const others = attrs.replace(new RegExp(HTML_ATTR.source, 'g'), (attr: string, _space: string, name: string) => (/^(?:lang|dir)$/i.test(name) ? '' : attr));
    return `${before}<${tag}${others}${end}`;
  });
}

const read = (path: string): string | null => {
  try {
    return templateBesidesLanguage(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

export function keepPageThroughAppTemplate(server: TemplateServer, templates: string[]): void {
  // A server that watches no files (one serving previews alone) hears of no change to answer.
  const watcher = server.watcher;
  if (!watcher) return;
  /** Each name a template goes by, to the file itself: a project opened through a link has two. */
  const fileOf = new Map(
    templates.map((path) => {
      try {
        return [same(path), same(realpathSync.native(path))] as const;
      } catch {
        return [same(path), same(path)] as const;
      }
    })
  );
  /** Each template file as last read, besides its language and direction, whichever name the watcher used. */
  const known = new Map([...new Set(fileOf.values())].map((file) => [file, read(file)] as const));
  /** While the watcher reports a change to a template that named only another language or direction. */
  let reporting = false;
  const emit = watcher.emit.bind(watcher);
  watcher.emit = (event: string | symbol, ...args: unknown[]) => {
    const file = typeof args[0] === 'string' ? fileOf.get(same(args[0])) : undefined;
    if (event !== 'change' || !file) return emit(event, ...args);
    const was = known.get(file) ?? null;
    const now = read(args[0] as string);
    known.set(file, now);
    reporting = was !== null && now !== null && now === was;
    try {
      return emit(event, ...args);
    } finally {
      reporting = false;
    }
  };
  // Vite's own reload for the file names it (and applies to no page here); SvelteKit's names no page, so reaches all.
  const isWholeReload = (args: unknown[]) => {
    const p = args.length === 1 ? (args[0] as { type?: unknown; path?: unknown } | null) : null;
    return !!p && typeof p === 'object' && p.type === 'full-reload' && p.path === undefined;
  };
  for (const hot of new Set([server.ws, server.environments?.client?.hot])) {
    if (!hot) continue;
    const send = hot.send.bind(hot);
    hot.send = (...args: unknown[]) => {
      if (reporting && isWholeReload(args)) return;
      send(...args);
    };
  }
}
