/**
 * What an author sees when the production build fails: the page or file it was working on, what went wrong, and a
 * technical report to copy into a support request. Pure text work on what the build worker reported; nothing here
 * depends on Electron, so it is unit tested directly.
 */
import type { PageDoc, ProjectState } from '@shared/types';
import { basePath, defFile, pageFile } from '@generator/index';
import { readablePath } from '@shared/routes';
import { errorChain, maskSecrets, REQUEST_LINE, STRONG_ERROR, stripTerminal, type BuildErrorInfo } from '../runtime/build-diagnostics';

/** What a failed build reported: the message it ended with, what it threw, and every line it printed. */
export interface BuildReport {
  error?: string;
  failure?: BuildErrorInfo;
  logs: string[];
}

/** A folder that build output may name, and what to show in its place. */
export interface PathRoot {
  path: string;
  label: string;
}

export interface BuildFailureContext {
  appVersion?: string;
  platform?: string;
  /** Folders whose absolute paths must not reach the author's screen or a support request. */
  roots?: PathRoot[];
}

export { maskSecrets, stripTerminal };

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One folder as a pattern: either slash, a file: URL's percent-encoding, and no name that merely starts the same way.
 * It starts only where no path or name runs into it, so a run of slashes is tried once, not from every position.
 */
function rootPattern(path: string): RegExp | null {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]+/);
  if (parts.every((p) => !p)) return null;
  const segment = (p: string) => {
    // A URL's escapes are read in either case (%2F and %2f are the same character).
    const lower = (t: string) => t.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
    const forms = [...new Set([p, encodeURI(p), encodeURIComponent(p), lower(encodeURI(p)), lower(encodeURIComponent(p))])].sort((a, b) => b.length - a.length);
    return forms.length === 1 ? escapeRegExp(p) : `(?:${forms.map(escapeRegExp).join('|')})`;
  };
  const windows = /^[a-z]:$/i.test(parts[0]) || path.includes('\\');
  // After the folder: the end, a separator, or something that ends a path in a message.
  const after = `(?=$|[\\\\/\\s'"\`()<>|:;,*?#\\[\\]{}])`;
  return new RegExp(`(?<![\\w.@+~%\\\\/-])${parts.map(segment).join('[\\\\/]+')}${after}((?:[\\\\/][^\\s'"\`()<>|:;,*?#]*)?)`, windows ? 'gi' : 'g');
}

/**
 * A function that shows each of these folders, wherever the text names one, as its label and what follows it in
 * forward slashes (a build's own paths can be absolute, in a temporary folder or under the author's home), so a
 * report names files by where they are in the project. Longer folders are replaced first, so a folder inside another
 * still gets its own label. Compile once and apply to every line.
 */
export function pathHider(roots: PathRoot[]): (text: string) => string {
  const seen = new Set<string>();
  const compiled = [...roots]
    .filter((r) => r.path && !seen.has(r.path) && !!seen.add(r.path))
    .sort((a, b) => b.path.length - a.path.length)
    .flatMap((r) => {
      const re = rootPattern(r.path);
      return re ? [{ re, label: r.label }] : [];
    });
  return (text) => {
    // file:///C:/a/b and file:///a/b are the same places as C:/a/b and /a/b.
    let out = text.replace(/file:\/\/\/(?=[A-Za-z]:)/gi, '').replace(/file:\/\/(?=\/)/gi, '');
    for (const { re, label } of compiled) out = out.replace(re, (_m, tail: string) => label + tail.replace(/\\/g, '/'));
    return out;
  };
}

export const hidePaths = (text: string, roots: PathRoot[]): string => pathHider(roots)(text);

const clip = (t: string, max: number) => (t.length > max ? `${t.slice(0, max)}…` : t);

/** A page's title as the headline and report show it: a title can be any length, and is the author's own text. */
export const pageTitle = (page: PageDoc) => clip(page.title.replace(/\s+/g, ' ').trim(), 80);
const firstLine = (t: string, max = 300) => clip(t.split('\n').find((l) => l.trim())?.trim() ?? '', max);

/** A message that only says the build failed, and nothing about why. */
const GENERIC = /^(?:(?:\w*Error:\s*)?(?:prerendering failed|build failed|the (?:production )?build failed)\.?)$/i;

/**
 * Printed lines that say nothing an author can act on: the framework's pointer to its own configuration, its error
 * code, and the route it failed on, which the headline already names. They stay in the report.
 */
const BOILERPLATE = /^(?:To suppress or handle this error\b|Failed to prerender\s+\S+$|prerender_\w+$)/i;
/** A printed line that reads as trouble but is not an exception. Warnings come after errors. */
const ERROR_WORD = /\b[A-Za-z]*Error\b|\b(?:failed|cannot|can't|could not|unexpected|not found|is not defined|is not a function|invalid|refused|exception|fatal|segmentation fault|out of memory|killed|aborted|core dumped)\b/i;
const WARNING = /^\s*(?:\(!\)|warn(?:ing)?\b|\[warn\])/i;
const STACK_FRAME = /^\s*at\s/;
const OMISSION = /^… \d+ (?:earlier )?lines? omitted$/;

/**
 * Where printed lines say a route was being built, most certain first: the framework's own failure notice, then
 * failed requests (a 4xx or 5xx status), then the missing-section notice and "prerendering /x". A request that
 * succeeded is never the route that failed. Only the first two outrank where an error says it was raised.
 */
const FAILED_ROUTE: RegExp[][] = [[/\bFailed to prerender\s+['"`]?(\/[^\s,;)'"`]*)/i], [/^\s*(?:[A-Za-z_$][\w$.]*Error:\s*)?\[?[45]\d\d\]?\s+(?:(?:GET|HEAD|POST)\s+)?(\/[^\s,;)'"`]*)/]];
const PROGRESS_ROUTE: RegExp[] = [/\bexists on (\/[^\s,;)'"`]*)/, /\b(?:prerender(?:ing|ed)?|render(?:ing|ed)?)\s+(?:of\s+)?(?:the\s+)?(?:route\s+|page\s+)?['"`]?(\/[^\s,;)'"`]*)/i];
const routeIn = (lines: string[], res: RegExp[]) => {
  for (const l of lines) {
    const hit = res.map((re) => re.exec(l)?.[1]).find(Boolean);
    if (hit) return hit;
  }
  return undefined;
};

/** A source file of the project's own a line names, with its line number: `<project>/src/lib/Hero.svelte:12:3`. */
const SOURCE_FILE = /(?:^|[\s(['"`])(?:<project>\/)?(src\/[^\s:()'"`<>?]+?\.(?:svelte|[cm]?[jt]sx?|css|scss|html))(?![\w.$/-])(?::(\d+))?/;
const sourceFile = (t: string | undefined) => (t ? SOURCE_FILE.exec(` ${t}`) : null);

function pageForRoute(state: ProjectState, route: string): PageDoc | undefined {
  const base = basePath(state);
  let r = readablePath(route.split(/[?#]/)[0]);
  if (base && (r === base || r.startsWith(`${base}/`))) r = r.slice(base.length) || '/';
  const same = (x: string) => x.replace(/\/+$/, '') + '/';
  return Object.values(state.pages).find((p) => same(p.route) === same(r));
}

const pageForFile = (state: ProjectState, file: string): PageDoc | undefined => Object.values(state.pages).find((p) => pageFile(p) === file);

/** An error as the first thing worth reading about it: `TypeError: x is not a function`. */
function errorLine(e: BuildErrorInfo, max = 300): string {
  const text = firstLine(e.message, max);
  return e.name && e.name !== 'Error' && !text.startsWith(e.name) ? `${e.name}: ${text}` : text;
}

function describeError(e: BuildErrorInfo, indent = ''): string[] {
  const out = [`${indent}${errorLine(e, Infinity)}`];
  const rest = e.message.split('\n').filter((l) => l.trim()).slice(1);
  for (const l of rest) out.push(`${indent}  ${l}`);
  const facts = [e.code && `code ${e.code}`, e.plugin && `plugin ${e.plugin}`, e.id && `module ${e.id}`, e.loc && `at ${[e.loc.file, e.loc.line, e.loc.column].filter((v) => v !== undefined).join(':')}`].filter(Boolean);
  if (facts.length) out.push(`${indent}  ${facts.join(', ')}`);
  if (e.frame) out.push(...e.frame.split('\n').map((l) => `${indent}  ${l}`));
  if (e.stack) {
    // The stack repeats the message on its first lines.
    const frames = e.stack.split('\n').filter((l) => STACK_FRAME.test(l));
    out.push(...frames.map((l) => `${indent}  ${l.trim()}`));
  }
  return out;
}

/** The report's size, in characters: the errors may take up to the first part, the build's printed lines the rest. */
const REPORT_LIMIT = 48_000;
const ERRORS_LIMIT = 24_000;
/** One printed line's size, which also bounds how long any pattern runs on it. */
const LINE_LIMIT = 2000;

/**
 * Which of the build's printed lines fit a report of `room` characters: lines that state a failure, with the lines
 * after them, take up to half of it; the newest lines fill the rest. In the order printed, with a mark where lines
 * are left out.
 */
function printedLines(lines: string[], room: number): string[] {
  const keep = new Set<number>();
  let used = 0;
  // A line apart from the others also costs the mark that says lines are left out before it.
  const take = (i: number, limit: number) => {
    const cost = lines[i].length + 3 + (keep.has(i - 1) || keep.has(i + 1) ? 0 : 40);
    if (keep.has(i) || used + cost > limit) return false;
    keep.add(i);
    used += cost;
    return true;
  };
  const withStack = (i: number, limit: number) => {
    if (!keep.has(i) && !take(i, limit)) return;
    for (let j = i + 1; j < lines.length && j <= i + 10 && STACK_FRAME.test(lines[j]); j++) take(j, limit);
  };
  const failures = lines.flatMap((l, i) => (STRONG_ERROR.test(l) && !WARNING.test(l) ? [i] : []));
  // The latest failure and its stack first (it ended the build), then the earliest ones in order (they began it).
  const latest = [...failures].reverse().find((i) => !REQUEST_LINE.test(lines[i])) ?? failures.at(-1);
  if (latest !== undefined) withStack(latest, room / 4);
  for (const i of failures) withStack(i, room / 2);
  for (let i = lines.length - 1; i >= 0; i--) if (!keep.has(i) && !take(i, room)) break;
  const out: string[] = [];
  let next = 0;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i > next) out.push(`… ${i - next} line${i - next === 1 ? '' : 's'} omitted`);
    out.push(lines[i]);
    next = i + 1;
  }
  return out;
}

export interface ExplainedBuild {
  /** Who and where: the headline for the author. */
  where: { page?: PageDoc; route?: string; file?: string; line?: number; /** The name of the project component the file is, when it is one. */ component?: string };
  /** The lines that say what went wrong, most useful first. */
  causes: string[];
  /** Every printed line, cleaned, without repeats. */
  lines: string[];
  /** The error's message, its causes' and each entry the build printed, cleaned and not yet split into lines. */
  entries: string[];
  /** The text to copy into a support request, under the headline the author was shown. */
  report: (headline: string) => string;
}

/**
 * Read a failed build for what an author needs: the cause (the exception at the root of the chain, else the lines the
 * build printed that read as errors), the page or file it was working on, and a report with all of it.
 */
export function readBuildFailure(state: ProjectState, build: BuildReport, ctx: BuildFailureContext = {}): ExplainedBuild {
  const hide = pathHider(ctx.roots ?? []);
  const clean = (t: string) => maskSecrets(hide(stripTerminal(t)));
  const cleanOpt = (t: string | undefined) => (t ? clean(t) : undefined);
  // Without a reported exception (a timeout, a worker that exited), the message the build ended with is the error.
  const thrown: BuildErrorInfo[] = build.failure ? errorChain(build.failure) : build.error ? [{ message: build.error }] : [];
  const chain = thrown.map((e) => ({
    ...e,
    name: cleanOpt(e.name),
    message: clean(e.message),
    code: cleanOpt(e.code),
    plugin: cleanOpt(e.plugin),
    stack: cleanOpt(e.stack),
    frame: cleanOpt(e.frame),
    id: cleanOpt(e.id),
    loc: e.loc && { ...e.loc, file: cleanOpt(e.loc.file) }
  }));
  const error = build.error ? clean(build.error) : '';
  const logs = build.logs.map(clean);
  const seen = new Set<string>();
  const lines = [error, ...logs]
    .flatMap((t) => t.split('\n'))
    .map((l) => clip(l.trimEnd(), LINE_LIMIT))
    // Each mark that says lines are missing stands for its own gap, however alike they read.
    .filter((l) => l.trim() && (OMISSION.test(l.trim()) || (!seen.has(l.trim()) && !!seen.add(l.trim()))));

  // The cause: the deepest error in the chain that says more than "failed", else the printed lines that state a failure
  // (an exception before a warning that merely mentions one), and a warning only when nothing else was said.
  const specific = [...chain].reverse().find((e) => !GENERIC.test(firstLine(e.message)));
  const printed = lines.filter((l) => !STACK_FRAME.test(l) && !GENERIC.test(l.trim()) && !BOILERPLATE.test(l.trim()));
  const strong = printed.filter((l) => STRONG_ERROR.test(l) && !WARNING.test(l));
  const found = [...strong.filter((l) => !REQUEST_LINE.test(l)), ...printed.filter((l) => ERROR_WORD.test(l) && !STRONG_ERROR.test(l) && !WARNING.test(l))];
  const causes: string[] = [];
  if (specific) causes.push(errorLine(specific));
  const add = (pool: string[]) => {
    const fresh = pool.map((l) => firstLine(l)).filter((text, i, all) => all.indexOf(text) === i && !causes.some((c) => c.includes(text) || text.includes(c)));
    // When there are more than fit, the first ones and the last one: the failure that began it and the one that ended it.
    const room = 4 - causes.length;
    causes.push(...(fresh.length > room && room > 1 ? [...fresh.slice(0, room - 1), fresh[fresh.length - 1]] : fresh.slice(0, room)));
  };
  add(found);
  // Warnings and failed requests only when nothing stated a failure.
  if (!causes.length) add([...printed.filter((l) => WARNING.test(l)), ...strong.filter((l) => REQUEST_LINE.test(l))]);

  // The file: where an error says it was raised (the deepest cause first), else the first project file in a stack, else
  // any project source file a line names. The route: a failed request or the framework's failure notice, else the page
  // of a file an error was raised in, else any mention of a route being rendered.
  const text = [...chain.flatMap((e) => [e.message, e.stack ?? '']), ...lines].flatMap((t) => t.split('\n'));
  let file: string | undefined;
  let line: number | undefined;
  let raised = false;
  for (const e of [...chain].reverse()) {
    const hit = sourceFile(e.loc?.file) ?? sourceFile(e.id);
    if (hit) {
      file = hit[1];
      line = e.loc?.line;
      raised = true;
      break;
    }
  }
  if (!file) {
    const frames = [...chain].reverse().flatMap((e) => (e.stack ?? '').split('\n')).filter((l) => STACK_FRAME.test(l));
    const hit = [...frames, ...text.filter((l) => STACK_FRAME.test(l))].map((l) => SOURCE_FILE.exec(l)).find(Boolean) ?? text.map((l) => SOURCE_FILE.exec(l)).find(Boolean);
    if (hit) {
      file = hit[1];
      line = hit[2] ? Number(hit[2]) : undefined;
    }
  }
  let route = FAILED_ROUTE.map((tier) => routeIn(text, tier)).find(Boolean);
  if (!route && raised && file) route = pageForFile(state, file)?.route;
  route ??= routeIn(text, PROGRESS_ROUTE);
  // A page is named only for the route that is its own: a request for something else that failed is not that page.
  const page = route ? pageForRoute(state, route) : file ? pageForFile(state, file) : undefined;
  if (page && !route) route = page.route;
  const componentName = file ? Object.values(state.components).find((c) => defFile(c) === file)?.name : undefined;
  // Names and paths are the project's own text, of any length: the headline and report show a bounded form.
  const component = componentName === undefined ? undefined : clip(componentName.replace(/\s+/g, ' ').trim(), 80);
  if (file) file = clip(file, 300);
  if (route) route = clip(route, 300);

  const report = (headline: string): string => {
    const head = [
      `SiteOrigin Builder ${ctx.appVersion ?? 'unknown version'} on ${ctx.platform ?? 'an unknown system'}`,
      headline,
      page ? `Page: ${pageTitle(page)} (${route})` : route ? `Route: ${route}` : '',
      file ? `File: ${file}${line ? `, line ${line}` : ''}${component ? ` (the “${component}” component)` : ''}` : ''
    ].filter(Boolean);
    // Each error in the chain gets an equal share, so wrappers with long frames cannot crowd out the cause at the root.
    const share = Math.floor(ERRORS_LIMIT / Math.max(chain.length, 1));
    const body: string[] = [];
    for (const [i, e] of chain.entries()) {
      const part = ['', i ? 'Caused by:' : 'Error:', ...describeError(e, '  ')];
      let size = 0;
      const fits = part.filter((l) => (size += l.length + 1) <= share);
      body.push(...fits);
      if (fits.length < part.length) body.push('  … more of this error is left out');
    }
    const fixed = [...head, ...body].join('\n');
    const printedBlock = lines.length ? printedLines(lines, Math.max(REPORT_LIMIT - fixed.length - 120, 0)) : [];
    const cut = printedBlock.some((l) => OMISSION.test(l));
    const output = printedBlock.length ? ['', `Build output${cut ? ' (the lines that matter most)' : ''}:`, ...printedBlock.map((l) => `  ${l}`)] : [];
    const whole = [fixed, ...output].join('\n');
    return whole.length > REPORT_LIMIT ? `${whole.slice(0, REPORT_LIMIT)}\n… (the rest of the report is left out)` : whole;
  };
  const entries = [...new Set([error, ...chain.map((e) => e.message), ...logs].filter(Boolean))];
  return { where: { page, route, file, line, component }, causes, lines, entries, report };
}
