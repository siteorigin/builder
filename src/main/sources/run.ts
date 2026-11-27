/**
 * One sync, as the sync worker runs it: read every record of the source with its kind's reader, check each, and fetch
 * the pictures of the records that changed since they were last synced, each written to the spool the main process
 * named as it arrives (or, with none, sent in the reply). The reply is all or nothing: a reader that
 * fails part way, a record that cannot be an entry or a picture that will not load fails the whole sync, so no entry
 * is ever drafted for a record that was only not read. Kept apart from the process so it can be tested.
 */
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { redactSecrets } from './redact';
import { effectiveMapping, graphqlReadProblem, holdsSecretValue } from '@shared/sources';
import { fillSecrets, fillSecretsJson } from '@shared/source-paths';
import { recordHash } from './hash';
import { AdapterError, type AdapterEnv, type SourceAdapter } from './registry';
import { createTransport, type Fetch } from './transport';
import { mappingFieldsProblem, mapRecord, MappingError, shapeConverted } from './mapping';
import { ConverterError, runConverter } from './converter';
import { contentfulRichText, htmlRichText, markdownRichText } from './richtext';
import {
  imageAddressProblem,
  imageKey,
  MAX_DETAIL,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_BYTES,
  MAX_RECORDS,
  MAX_RECORDS_BYTES,
  SAMPLE_SIZE,
  spoolFile,
  recordImages,
  recordProblem,
  type NormalizedRecord,
  type SourceImage,
  type SyncFailure,
  type SyncImage,
  type SyncReply,
  type SyncRequest
} from './protocol';

/**
 * A picture's type and bytes, fetched from its address (see fetch-image.ts): with a `sink`, its bytes are handed to it
 * piece by piece as they arrive, and only their count comes back.
 */
export type ImageFetcher = (
  url: string,
  maxBytes: number,
  signal: AbortSignal,
  check: (url: string) => string | null,
  sink?: (chunk: Uint8Array) => Promise<void>
) => Promise<{ mime: string; bytes?: Uint8Array; size?: number }>;

/** A new file of a sync's spool, for the picture at `index` of the reply: never one already there (a link put in its place, say). */
const openSpoolFile = (spool: string, index: number): Promise<FileHandle> => fs.open(join(spool, spoolFile(index)), 'wx', 0o600);

/** Why a picture fetched into a spool is not there: its file could not be made, written or closed. */
const KEEP_FAILED = 'a picture could not be kept while it was fetched';

/** Write all of `chunk` at the end of what `file` holds so far. */
async function writeAll(file: FileHandle, chunk: Uint8Array): Promise<void> {
  for (let at = 0; at < chunk.byteLength; ) at += (await file.write(chunk, at, chunk.byteLength - at)).bytesWritten;
}

export interface RunDeps {
  adapters: Readonly<Record<string, SourceAdapter>>;
  fetchImage: ImageFetcher;
  /** Why a picture's host is not one a sync fetches from (it resolves to this computer), checked by a sample. */
  checkHost?: (url: string) => Promise<string | null>;
  signal?: AbortSignal;
  /** How a source's server is asked: the platform's fetch, or a test's. */
  fetch?: Fetch;
  env?: AdapterEnv;
}

/**
 * A converter's request (fetchAll's), made at the source's own server with the source's own headers. A source only
 * reads, so a converter asks with GET; a GraphQL source's may also POST a query, one that only reads.
 */
function converterRequest(init: Record<string, unknown>, secrets: Readonly<Record<string, string>>, adapter: string) {
  const fill = (v: unknown, json = false) => {
    if (typeof v !== 'string') throw new ConverterError('a request’s headers, query and body are text');
    const r = json ? fillSecretsJson(v, secrets) : fillSecrets(v, secrets);
    if (r.missing !== null) throw new ConverterError(`no secret called ${r.missing} is named by the source’s settings`);
    return r.text;
  };
  const map = (m: unknown) => (m && typeof m === 'object' && !Array.isArray(m) ? Object.fromEntries(Object.entries(m).map(([k, v]) => [k, fill(v)])) : {});
  const method = init.method === undefined ? 'GET' : init.method === 'GET' || (init.method === 'POST' && adapter === 'graphql') ? init.method : null;
  if (!method) throw new ConverterError(adapter === 'graphql' ? 'a converter only reads: it asks with GET, or POSTs a GraphQL query' : 'a converter only reads: it asks with GET');
  if (method === 'GET' && init.body !== undefined) throw new ConverterError('a GET request sends nothing');
  let body: string | undefined;
  if (method === 'POST') {
    const sent = typeof init.body === 'string' ? (() => { try { return JSON.parse(init.body as string) as unknown; } catch { return undefined; } })() : init.body;
    const query = (sent as { query?: unknown } | undefined)?.query;
    // Checked as it is sent: a secret filled into a query could change what it asks.
    if (typeof query === 'string' && query.includes('${')) throw new ConverterError('its request names a secret in its GraphQL query: send it in a header or a variable instead');
    const problem = graphqlReadProblem(query);
    if (problem) throw new ConverterError(`its request ${problem.replace(/^its /, 'has a ')}`);
    body = fill(JSON.stringify(sent), true);
  }
  return { method, headers: map(init.headers), query: map(init.query), body } as const;
}

/** The pictures the library takes from a sync, by type. */
export const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif' };

/** An address as a server reads it, as well as written: decoded, and its query's names and values as a form reads them. */
function addressViews(url: string): string {
  const out = [url];
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  // Each escape on its own too, so one that is no text (%FF) never keeps the others from being read.
  const bytewise = (s: string) => s.replace(/%([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  out.push(decode(url), bytewise(url));
  try {
    const u = new URL(url);
    out.push(u.href, decode(u.pathname), decode(u.hash), bytewise(u.pathname), bytewise(u.hash));
    for (const [k, v] of u.searchParams) out.push(k, v);
  } catch {
    // Not an address: checked as written.
  }
  return out.join('\n');
}

/** The most a record shown as the source sent it may be; a larger one is said, not shown. */
const MAX_SAMPLE_BYTES = 200_000;

/** A record as a sample shows it: as the source sent it, or a note of its size when it is too large to show. */
function sampleView(item: unknown): unknown {
  const text = JSON.stringify(item ?? null);
  const bytes = Buffer.byteLength(text);
  return bytes <= MAX_SAMPLE_BYTES ? (JSON.parse(text) as unknown) : `(This record is ${Math.round(bytes / 1000)} KB, too large to show here.)`;
}

export async function runSync(req: SyncRequest, deps: RunDeps): Promise<SyncReply> {
  const secrets = Object.values(req.secrets ?? {});
  const failed = (code: SyncFailure, detail?: string): SyncReply => ({
    id: req.id,
    ok: false,
    code,
    // Taken out before it is cut short, so no part of a secret is left at the cut.
    ...(detail ? { detail: redactSecrets(detail, secrets).slice(0, MAX_DETAIL) } : {})
  });
  const signal = deps.signal ?? new AbortController().signal;
  const adapter = Object.hasOwn(deps.adapters, req.adapter) ? deps.adapters[req.adapter] : undefined;
  if (!adapter) return failed('adapter-unavailable');
  const given = Object.freeze({ ...req.secrets });
  const fields = req.fields ?? {};
  let records: NormalizedRecord[];
  let raw: unknown[] | undefined;
  try {
    // A reader that puts its records in shape itself has no records as sent to show.
    if (adapter.read && req.mode === 'inspect') return failed('adapter-unavailable');
    if (adapter.read) records = await adapter.read(req.config, given, signal);
    else {
      if (!adapter.items || !adapter.origin) return failed('adapter-unavailable');
      const transport = createTransport(adapter.origin(req.config, deps.env ?? {}), signal, deps.fetch);
      const headers = () => adapter.headers?.(req.config, given) ?? {};
      // What a converter is given never holds a secret the source was sent (a server echoing its token): a converter
      // could change it past knowing, then write it out.
      const echoed = (v: unknown) => holdsSecretValue(JSON.stringify(v ?? null), secrets);
      const ECHO = 'the source sent back one of the secrets it was sent, which a converter is never given';
      const items = async () => {
        const read = await adapter.items!({ config: req.config, secrets: given, signal, transport, env: deps.env ?? {} });
        if (typeof req.converter === 'string' && echoed(read)) throw new AdapterError('invalid', ECHO);
        return read;
      };
      // The records as the kind of source reads them, put in no shape: its mapping and converter are what is being
      // written, so neither may stand between the source and what the assistant reads.
      if (req.mode === 'inspect') {
        const read = await adapter.items({ config: req.config, secrets: given, signal, transport, env: deps.env ?? {} });
        if (!Array.isArray(read)) return failed('invalid', 'the reader gave no list of records');
        if (read.length > MAX_RECORDS) return failed('too-large', `it has more than ${MAX_RECORDS} records`);
        try {
          return { id: req.id, ok: true, records: [], images: [], raw: read.slice(0, SAMPLE_SIZE).map(sampleView), total: read.length };
        } catch {
          return failed('invalid', 'a record cannot be read');
        }
      }
      let read: unknown[];
      let shaped: unknown;
      if (typeof req.converter === 'string') {
        const out = await runConverter(
          req.converter,
          {
            richText: (kind, text) => (kind === 'contentful' ? contentfulRichText(JSON.parse(text)) : kind === 'html' ? htmlRichText(text) : markdownRichText(text)),
            fetchJson: async (url, init) => {
              const r = converterRequest(init as Record<string, unknown>, given, req.adapter);
              let u: URL;
              try {
                u = new URL(String(url), transport.origin);
              } catch {
                throw new ConverterError('a request’s address cannot be read');
              }
              for (const [k, v] of Object.entries(r.query)) u.searchParams.set(k, v);
              // A GraphQL query is posted to the source's own address for queries, and nowhere else on its server.
              if (r.method === 'POST' && `${u.origin}${u.pathname}` !== (() => { const c = new URL(req.config.url ?? ''); return `${c.origin}${c.pathname}`; })())
                throw new ConverterError('a converter posts a GraphQL query only to the source’s own address');
              let reply: unknown;
              try {
                reply = (await transport.json(u.href, { method: r.method, headers: { ...headers(), ...r.headers }, ...(r.body !== undefined ? { body: r.body } : {}) })).body;
              } catch (e) {
                throw new ConverterError(e instanceof AdapterError ? (e.detail ?? 'the source could not be asked') : 'the source could not be asked');
              }
              if (echoed(reply)) throw new ConverterError(ECHO);
              return reply;
            }
          },
          items
        );
        read = out.items;
        if (!Array.isArray(out.records)) return failed('converter', 'its convert gave no list of records');
        shaped = out.records.map((r) => shapeConverted(r, fields));
      } else {
        const mapping = effectiveMapping(req.adapter, req.mapping);
        // Said before anything is read, so a source with no records yet never makes a mapping look right.
        const wrong = mappingFieldsProblem(mapping, fields);
        if (wrong) return failed('invalid', wrong);
        read = await items();
        shaped = read.map((item, i) => mapRecord(item, mapping, fields, i));
      }
      records = shaped as NormalizedRecord[];
      if (req.mode === 'sample') raw = read.slice(0, SAMPLE_SIZE);
    }
  } catch (e) {
    // What a reader throws is never passed on as it is: it may hold what the server echoed back.
    if (e instanceof ConverterError) return failed('converter', e.message);
    if (e instanceof MappingError) return failed('invalid', e.message);
    return e instanceof AdapterError ? failed(e.code, e.detail) : failed('failed');
  }
  if (!Array.isArray(records)) return failed('invalid', 'the reader gave no list of records');
  if (records.length > MAX_RECORDS) return failed('too-large', `it has more than ${MAX_RECORDS} records`);
  const ids = new Set<string>();
  for (const [i, r] of records.entries()) {
    const problem = recordProblem(r);
    if (problem) return failed('invalid', records.length > 1 ? `${problem} (record ${i + 1})` : problem);
    if (ids.has(r.externalId)) return failed('invalid', 'two records have the same ID');
    ids.add(r.externalId);
  }
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(records));
  } catch {
    return failed('invalid', 'a record cannot be read');
  }
  if (size > MAX_RECORDS_BYTES) return failed('too-large', 'its records are too large to sync');
  // Never an address that carries a secret (an image host is not the source, and need not see it), nor one on this
  // computer or the local network.
  const checkAddress = (url: string) => (holdsSecretValue(addressViews(url), secrets) ? 'a picture’s address holds a secret' : imageAddressProblem(url));
  // A sample fetches no picture: it shows what a sync would write, and writes nothing. Each picture's address is
  // checked as a sync checks it, so settings whose sync could only fail are said at once.
  if (req.mode === 'sample') {
    const seen = new Set<string>();
    for (const r of records)
      for (const img of recordImages(r)) {
        if (seen.has(img.url)) continue;
        seen.add(img.url);
        const refused = checkAddress(img.url) ?? (deps.checkHost && !req.offline ? await deps.checkHost(img.url) : null);
        if (refused) return failed('image', refused);
      }
    try {
      return { id: req.id, ok: true, records, images: [], raw: (raw ?? []).map(sampleView) };
    } catch {
      return failed('invalid', 'a record cannot be read');
    }
  }
  // Only the pictures of records that changed: an unchanged record's are in the library already.
  const wanted = new Map<string, SourceImage>();
  for (const r of records) {
    if (Object.hasOwn(req.known ?? {}, r.externalId) && req.known[r.externalId] === recordHash(r)) continue;
    for (const img of recordImages(r)) if (!wanted.has(imageKey(img))) wanted.set(imageKey(img), img);
  }
  // With a spool, each picture is written to its file as it arrives and is never held: only its size is sent.
  const spool = req.spool;
  const images: SyncImage[] = [];
  let total = 0;
  for (const [key, img] of wanted) {
    const refused = checkAddress(img.url);
    if (refused) return failed('image', refused);
    const max = Math.min(MAX_IMAGE_BYTES, MAX_IMAGES_BYTES - total);
    let got: Awaited<ReturnType<ImageFetcher>>;
    let file: FileHandle | null = null;
    let written = 0;
    const keep = async (chunk: Uint8Array) => {
      written += chunk.byteLength;
      if (written > max) throw new AdapterError('too-large', 'its pictures are too large to sync');
      await writeAll(file!, chunk).catch(() => {
        throw new AdapterError('failed', KEEP_FAILED);
      });
    };
    try {
      if (spool !== undefined) file = await openSpoolFile(spool, images.length).catch(() => {
        throw new AdapterError('failed', KEEP_FAILED);
      });
      got = await deps.fetchImage(img.url, max, signal, checkAddress, file ? keep : undefined);
      // A fetcher that answers with the bytes all at once has them written as one piece.
      if (file && got.bytes) await keep(got.bytes);
      // Closed before it is said to be there: a write the system reports only on closing fails the sync too.
      if (file) {
        const kept = file;
        file = null;
        await kept.close().catch(() => {
          throw new AdapterError('failed', KEEP_FAILED);
        });
      }
    } catch (e) {
      return failed(e instanceof AdapterError ? e.code : 'image', e instanceof AdapterError ? e.detail : undefined);
    } finally {
      await file?.close().catch(() => undefined);
    }
    const size = spool !== undefined ? written : got.bytes?.byteLength;
    if (size === undefined) return failed('image');
    const mime = got.mime.split(';')[0].trim().toLowerCase();
    const ext = Object.hasOwn(IMAGE_EXTENSIONS, mime) ? IMAGE_EXTENSIONS[mime] : undefined;
    if (!ext) return failed('image', 'a picture is not a JPEG, PNG, WebP, GIF or AVIF image');
    total += size;
    if (size > MAX_IMAGE_BYTES || total > MAX_IMAGES_BYTES) return failed('too-large', 'its pictures are too large to sync');
    images.push(spool !== undefined ? { key, mime, ext, size } : { key, mime, ext, size, bytes: got.bytes });
  }
  return { id: req.id, ok: true, records, images };
}
