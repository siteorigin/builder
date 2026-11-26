/**
 * A source's converter (`siteorigin/sources/<id>/converter.mjs`, #678): the author's own ES module that puts the
 * records a source sends in the shape of entries, exporting `convert(items, helpers)` and, to read the source its own
 * way, `async fetchAll(helpers)`.
 *
 * It is checked before it is ever run, by its syntax tree (Acorn's, never its text): only declarations and those two
 * exports, with no import of any kind, no dynamic code, and none of the names that reach out of the language (Node's
 * modules and globals, `eval`, `Function`, prototypes). It runs in the sync worker in a context of its own, which can
 * compile no code from text, and which nothing of the worker's enters: the records go in as text and come out as text,
 * and its helpers are made in that context. The few the worker answers (reading formatted text, and `fetchAll`'s
 * requests, to the source's own server only, with the secrets the settings name filled in by the worker) take and give
 * text only. A converter never sees a secret's value. The check is a guard rail as codecheck's is; the worker, a
 * process of its own ended as soon as a sync answers or takes too long, is the boundary.
 */
import { parse, type Node } from 'acorn';
import vm from 'node:vm';

export interface ConverterProblem {
  message: string;
  line?: number;
  column?: number;
}

/** Names that reach out of the converter, as a name or a property, written in any way the tree can see. */
const FORBIDDEN = new Set([
  'require',
  'process',
  'module',
  'exports',
  'global',
  'globalThis',
  'Buffer',
  '__dirname',
  '__filename',
  'eval',
  'Function',
  'AsyncFunction',
  'GeneratorFunction',
  'constructor',
  '__proto__',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  'Reflect',
  'Proxy',
  'WebAssembly',
  'Atomics',
  'SharedArrayBuffer',
  'getPrototypeOf',
  'setPrototypeOf',
  'getOwnPropertyDescriptor',
  'getOwnPropertyDescriptors',
  'defineProperty',
  'defineProperties',
  'prepareStackTrace',
  'captureStackTrace',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'queueMicrotask',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'importScripts',
  'fs',
  'child_process'
]);

const EXPORTS = new Set(['convert', 'fetchAll']);

type AnyNode = Node & Record<string, unknown>;

/** Every node in `n`, each once. */
function walk(n: unknown, visit: (n: AnyNode) => void) {
  if (!n || typeof n !== 'object') return;
  if (Array.isArray(n)) return n.forEach((x) => walk(x, visit));
  const node = n as AnyNode;
  if (typeof node.type !== 'string') return;
  visit(node);
  for (const [k, v] of Object.entries(node)) if (k !== 'loc' && v && typeof v === 'object') walk(v, visit);
}

/** A literal's text, as a computed property's name: `x["constructor"]`, `x[`constructor`]`. */
function literalName(n: AnyNode | undefined): string | null {
  if (!n) return null;
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n.type === 'TemplateLiteral' && Array.isArray(n.quasis) && n.quasis.length === 1) return (n.quasis[0] as { value: { cooked: string } }).value.cooked;
  return null;
}

/** A parsed module, or why it cannot be one. */
function parsed(code: string): { ast: AnyNode } | { problem: ConverterProblem } {
  try {
    return { ast: parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: false }) as unknown as AnyNode };
  } catch (e) {
    const loc = (e as { loc?: { line: number; column: number } }).loc;
    return { problem: { message: `It cannot be read as JavaScript: ${(e as Error).message.replace(/\s*\(\d+:\d+\)$/, '')}.`, ...(loc ? { line: loc.line, column: loc.column + 1 } : {}) } };
  }
}

/**
 * What stops a converter from being run, or an empty list: the first problem of each kind, with where it is. Only the
 * names of what it holds are quoted, never its text.
 */
export function converterProblems(code: string): ConverterProblem[] {
  if (typeof code !== 'string' || !code.trim()) return [{ message: 'It is empty. Export a convert(items, helpers) function.' }];
  const p = parsed(code);
  if ('problem' in p) return [p.problem];
  const out: ConverterProblem[] = [];
  const at = (n: AnyNode, message: string) => {
    if (out.length < 20) out.push({ message, line: n.loc?.start.line, column: (n.loc?.start.column ?? 0) + 1 });
  };
  const exported = new Set<string>();
  for (const s of p.ast.body as AnyNode[]) {
    if (s.type === 'ImportDeclaration') at(s, 'It imports a module. A converter uses only its helpers: everything it needs comes through them.');
    else if (s.type === 'ExportAllDeclaration' || s.type === 'ExportDefaultDeclaration' || (s.type === 'ExportNamedDeclaration' && (!s.declaration || s.source)))
      at(s, 'It exports in a way a converter cannot: write export function convert(items, helpers) { … }.');
    else if (s.type === 'ExportNamedDeclaration') {
      const d = s.declaration as AnyNode;
      const names = d.type === 'FunctionDeclaration' ? [(d.id as AnyNode).name as string] : d.type === 'VariableDeclaration' ? (d.declarations as AnyNode[]).map((x) => ((x.id as AnyNode).type === 'Identifier' ? ((x.id as AnyNode).name as string) : '')) : [];
      if (d.type === 'VariableDeclaration' && d.kind !== 'const') at(s, 'It exports a variable that can change. Export convert as a function, or as a const.');
      for (const n of names) {
        if (!EXPORTS.has(n)) at(s, `It exports ${n || 'a pattern'}, which nothing reads. A converter exports convert and, to read the source itself, fetchAll.`);
        else exported.add(n);
      }
    } else if (s.type === 'FunctionDeclaration' || (s.type === 'VariableDeclaration' && s.kind !== 'var')) continue;
    else if (s.type === 'ExpressionStatement' && typeof s.directive === 'string') continue;
    else at(s, 'Only functions and constants may be declared at the top of a converter: work belongs in convert.');
  }
  if (!exported.has('convert')) out.push({ message: 'It exports no convert(items, helpers) function.' });
  walk(p.ast, (n) => {
    if (n.type === 'ImportExpression') at(n, 'It loads a module with import(). A converter uses only its helpers.');
    else if (n.type === 'MetaProperty') at(n, 'It reads import.meta or new.target, which a converter has no use for.');
    else if (n.type === 'WithStatement') at(n, 'It uses with, which a converter cannot.');
    else if (n.type === 'ClassDeclaration' || n.type === 'ClassExpression') at(n, 'It declares a class. Use functions and plain objects instead.');
    else if (n.type === 'Identifier' && FORBIDDEN.has(n.name as string)) at(n, `It uses ${n.name as string}, which a converter may not reach.`);
    else if (n.type === 'MemberExpression' && n.computed) {
      const name = literalName(n.property as AnyNode);
      if (name !== null && FORBIDDEN.has(name)) at(n, `It uses ${name}, which a converter may not reach.`);
    } else if ((n.type === 'Property' || n.type === 'MethodDefinition' || n.type === 'PropertyDefinition') && n.computed) {
      const name = literalName(n.key as AnyNode);
      if (name !== null && FORBIDDEN.has(name)) at(n, `It uses ${name}, which a converter may not reach.`);
    } else if ((n.type === 'Property' || n.type === 'MethodDefinition') && !n.computed && (n.key as AnyNode)?.type === 'Literal' && FORBIDDEN.has(String((n.key as AnyNode).value))) at(n, `It uses ${String((n.key as AnyNode).value)}, which a converter may not reach.`);
  });
  return out;
}

/** The problems, one per line, as an author reads them. */
export const converterProblemText = (problems: readonly ConverterProblem[]): string => problems.map((p) => (p.line ? `Line ${p.line}: ${p.message}` : p.message)).join('\n');

/** The module as one script: its exports declared as they are, the two that are read returned. */
function asScript(code: string, ast: AnyNode): string {
  let out = '';
  let from = 0;
  for (const s of ast.body as AnyNode[]) {
    if (s.type !== 'ExportNamedDeclaration') continue;
    out += code.slice(from, s.start);
    from = (s.declaration as AnyNode).start;
  }
  out += code.slice(from);
  // On the module's first line, so a problem's line is the author's.
  return `(function () { 'use strict'; ${out}\n;return { convert: typeof convert === 'function' ? convert : undefined, fetchAll: typeof fetchAll === 'function' ? fetchAll : undefined }; })()`;
}

/**
 * The converter's helpers and the two calls that run it, made in its own context before any of its code runs, with
 * the language's own functions they use kept as they were then. `bridge` (the worker's, taking and giving text only)
 * is kept in a closure the converter cannot reach. No promise or error of the worker's ever enters the context, and no
 * function of the worker's but `bridge` and fetchAll's `done`, each called only by this code, with text.
 */
const HELPERS = String.raw`(function (bridge) {
  'use strict';
  const $String = String, $parse = JSON.parse, $stringify = JSON.stringify, $Promise = Promise, $Error = Error, $hasOwn = Object.hasOwn, $freeze = Object.freeze;
  // A stack is only ever text here: no code of the converter's can see a stack's frames.
  Object.defineProperty(Error, 'prepareStackTrace', { value: undefined, writable: false, configurable: false });
  const ask = (kind, arg) => {
    let reply;
    try {
      reply = bridge(kind, $String(arg));
    } catch (e) {
      throw new $Error('The helper could not answer.');
    }
    if (typeof reply !== 'string') throw new $Error('The helper could not answer.');
    const r = $parse(reply);
    if (r.error) throw new $Error($String(r.error));
    return r.value;
  };
  const steps = (path) => $String(path).split('.').flatMap((part) => part.split(/\[(\d+)\]/).filter((s) => s !== ''));
  const get = (value, path) => {
    let at = value;
    for (const step of steps(path)) {
      if (at === null || typeof at !== 'object') return undefined;
      if (!$hasOwn(at, step)) return undefined;
      at = at[step];
    }
    return at;
  };
  const image = (url, details) => {
    if (typeof url !== 'string' || !url.trim()) return undefined;
    const u = url.trim().startsWith('//') ? 'https:' + url.trim() : url.trim();
    const d = details && typeof details === 'object' ? details : {};
    const out = { url: u };
    for (const k of ['id', 'name', 'alt']) if (typeof d[k] === 'string' && d[k]) out[k] = d[k];
    return { $image: out };
  };
  const date = (v) => {
    if (typeof v === 'number' && Number.isFinite(v) && Number.isFinite(new Date(v).getTime())) return new Date(v).toISOString().slice(0, 10);
    const m = /^(\d{4}-\d{2}-\d{2})/.exec($String(v ?? '').trim());
    return m ? m[1] : undefined;
  };
  const text = (s) => $String(s ?? '').split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean).map((p) => ({ type: 'p', spans: [{ text: p }] }));
  const richText = $freeze({
    fromText: text,
    fromHtml: (html) => ask('html', html ?? ''),
    fromMarkdown: (md) => ask('markdown', md ?? ''),
    fromContentful: (doc) => ask('contentful', $stringify(doc ?? null))
  });
  const fetchJson = (url, init) =>
    new $Promise((resolve, reject) => {
      let request;
      try {
        request = $stringify({ url: $String(url), init: init && typeof init === 'object' ? init : {} });
      } catch (e) {
        return reject(new $Error('The request cannot be read.'));
      }
      const answered = (reply) => {
        try {
          const r = $parse($String(reply));
          if (r.error) reject(new $Error($String(r.error)));
          else resolve(r.value);
        } catch (e) {
          reject(new $Error('The source could not be asked.'));
        }
      };
      try {
        bridge('fetch', request, answered);
      } catch (e) {
        reject(new $Error('The source could not be asked.'));
      }
    });
  const helpers = (fetching) => $freeze({ get, image, date, richText, ...(fetching ? { fetchJson } : {}) });
  /** convert, given the records as text: what it gave, as text. */
  const runConvert = (f, items) => {
    const out = f($parse(items), helpers(false));
    if (out && typeof out.then === 'function') throw new $Error('convert must give its records, not a promise: make it a plain function');
    return $stringify(out === undefined ? null : out);
  };
  /** fetchAll: \`done(true, records as text)\`, or \`done(false, the error)\`, once. */
  const runFetchAll = (f, done) => {
    let settled = false;
    const end = (ok, v) => {
      if (settled) return;
      settled = true;
      done(ok, v);
    };
    let pending;
    try {
      pending = f(helpers(true));
    } catch (e) {
      return end(false, e);
    }
    $Promise.resolve(pending).then(
      (v) => {
        let t;
        try {
          t = $stringify(v === undefined ? null : v);
        } catch (e) {
          return end(false, e);
        }
        end(true, $String(t));
      },
      (e) => end(false, e)
    );
  };
  return $freeze({ runConvert, runFetchAll });
})`;

/** What the worker answers for a converter's helpers: text in, and a JSON `{ value }` or `{ error }` out, never a throw. */
export interface ConverterHost {
  richText(kind: 'html' | 'markdown' | 'contentful', text: string): unknown;
  /** fetchAll's requests: the source's own server only. */
  fetchJson?(url: string, init: { method?: unknown; headers?: unknown; query?: unknown; body?: unknown }): Promise<unknown>;
}

export class ConverterError extends Error {}

/** How long a converter's convert may run, and its module's own start. */
const RUN_MS = 10_000;

/**
 * Text a value of the converter's holds at `key`, read without running any code of its: its own plain property, or
 * the context's own native stack. Anything else reads as nothing.
 */
function ownText(v: unknown, key: string, nativeStack: unknown): string | undefined {
  if (!v || (typeof v !== 'object' && typeof v !== 'function')) return undefined;
  try {
    const d = Object.getOwnPropertyDescriptor(v, key);
    if (typeof d?.value === 'string') return d.value;
    if (d?.get && d.get === nativeStack) {
      const t = (d.get as () => unknown).call(v);
      return typeof t === 'string' ? t : undefined;
    }
  } catch {
    // Unreadable.
  }
  return undefined;
}

/** A converter's error as the author reads it: its message and the line of the converter it was thrown at. */
function thrown(e: unknown, what: string, timeout: number, nativeStack: unknown): ConverterError {
  // The worker's own error when the converter ran out of time.
  const text = e instanceof Error ? e.message : typeof e === 'string' ? e : (ownText(e, 'message', nativeStack) ?? '');
  if (/^Script execution timed out/.test(text)) return new ConverterError(`${what} took longer than ${Math.round(timeout / 100) / 10} seconds`);
  // Cut past the longest secret kept, so the secrets are taken out (see run.ts) before the cut that is shown.
  const message = text.slice(0, 200_000) || 'it stopped with an error';
  const at = /converter\.mjs:(\d+):(\d+)/.exec(ownText(e, 'stack', nativeStack) ?? '');
  return new ConverterError(`${what} failed${at ? ` (line ${at[1]})` : ''}: ${message}`);
}

/**
 * Run converter `code`: its `fetchAll` (when it has one and `fetched` is not given) reads the source's records, then
 * `convert` puts them in shape. Resolves with what convert gave, as plain data, or rejects with a ConverterError the
 * author can act on.
 */
export async function runConverter(code: string, host: ConverterHost, items: () => Promise<unknown[]>, limits: { timeoutMs?: number } = {}): Promise<{ items: unknown[]; records: unknown }> {
  const timeout = limits.timeoutMs ?? RUN_MS;
  const problems = converterProblems(code);
  if (problems.length) throw new ConverterError(converterProblemText(problems));
  const ast = (parsed(code) as { ast: AnyNode }).ast;
  const context = vm.createContext(Object.create(null), { name: 'converter', codeGeneration: { strings: false, wasm: false } });
  /** The worker's answer to the helpers: text in, text out (fetchAll's through `done`), and never a throw. */
  const bridge = (kind: unknown, arg: unknown, done?: unknown): string | undefined => {
    const answer = (f: () => unknown) => {
      try {
        return JSON.stringify({ value: f() ?? null });
      } catch (e) {
        return JSON.stringify({ error: e instanceof ConverterError ? e.message : 'the helper could not read what it was given' });
      }
    };
    if (typeof arg !== 'string') return JSON.stringify({ error: 'the helper could not read what it was given' });
    if (kind === 'fetch') {
      if (typeof done !== 'function') return undefined;
      const reply = (text: string) => {
        try {
          (done as (t: string) => void)(text);
        } catch {
          // The converter's own answer failed in its own context.
        }
      };
      if (!host.fetchJson) {
        reply(JSON.stringify({ error: 'Only fetchAll can ask the source.' }));
        return undefined;
      }
      let req: { url: string; init: Record<string, unknown> };
      try {
        req = JSON.parse(arg);
      } catch {
        reply(JSON.stringify({ error: 'the request cannot be read' }));
        return undefined;
      }
      void host.fetchJson(String(req.url), req.init && typeof req.init === 'object' ? req.init : {}).then(
        (v) => reply(JSON.stringify({ value: v ?? null })),
        (e: unknown) => reply(JSON.stringify({ error: e instanceof ConverterError ? e.message : 'the source could not be asked' }))
      );
      return undefined;
    }
    if (kind === 'html' || kind === 'markdown') return answer(() => host.richText(kind, arg));
    if (kind === 'contentful') return answer(() => host.richText('contentful', arg));
    return JSON.stringify({ error: 'there is no such helper' });
  };
  const opts = { filename: 'converter.mjs', timeout, displayErrors: false };
  const g = context as Record<string, unknown>;
  let api: { runConvert: unknown; runFetchAll: unknown };
  let nativeStack: unknown;
  let box: (...a: unknown[]) => unknown[];
  let wrap: (done: (ok: unknown, v: unknown) => void) => unknown;
  let exports: { convert?: unknown; fetchAll?: unknown };
  try {
    // Made before any code of the converter's runs.
    api = (vm.runInContext(HELPERS, context, { filename: 'helpers.js' }) as (b: typeof bridge) => typeof api)(bridge);
    nativeStack = Object.getOwnPropertyDescriptor(vm.runInContext('new Error()', context), 'stack')?.get;
    box = vm.runInContext('(...a) => a', context) as typeof box;
    // fetchAll's \`done\` reaches the context only inside a function of its own, which calls it and gives nothing of it away.
    wrap = vm.runInContext('(d) => (ok, v) => { d(ok, v); }', context) as typeof wrap;
  } catch {
    throw new ConverterError('The converter could not be started.');
  }
  try {
    exports = vm.runInContext(asScript(code, ast), context, opts) as typeof exports;
  } catch (e) {
    throw thrown(e, 'Its module', timeout, nativeStack);
  }
  if (!exports || typeof exports !== 'object') throw new ConverterError('Its module gave nothing to run.');
  // Each run is a script of the context's own, so the time its own work takes is limited; what it is given is a list of
  // the context's own, set beside it and taken away again.
  const run = <T>(args: unknown[], what: string): T => {
    g.__job = box(...args);
    try {
      return vm.runInContext('__job[0](__job[1], __job[2])', context, opts) as T;
    } catch (e) {
      throw thrown(e, what, timeout, nativeStack);
    } finally {
      delete g.__job;
    }
  };
  let input: unknown[];
  if (typeof exports.fetchAll === 'function') {
    const text = await new Promise<string>((resolve, reject) => {
      const done = (ok: unknown, v: unknown) => (ok === true && typeof v === 'string' ? resolve(v) : reject(thrown(v, 'Its fetchAll', timeout, nativeStack)));
      try {
        run([api.runFetchAll, exports.fetchAll, wrap(done)], 'Its fetchAll');
      } catch (e) {
        reject(e);
      }
    });
    const got = JSON.parse(text) as unknown;
    if (!Array.isArray(got)) throw new ConverterError('Its fetchAll gave no list of records.');
    input = got;
  } else input = await items();
  const out = run<unknown>([api.runConvert, exports.convert, JSON.stringify(input)], 'Its convert');
  if (typeof out !== 'string') throw new ConverterError('Its convert gave nothing that can be read.');
  return { items: input, records: JSON.parse(out) as unknown };
}
