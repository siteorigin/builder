/**
 * The kinds of source the sync worker can read, by the name a source's settings give (`adapter`): a REST or GraphQL
 * API, Contentful, Sanity, Strapi and WordPress, each with the platform's own fetch and no package to install. Each
 * reads every record its source has as the source sends it; the records are then put in the shape of entries by the
 * source's mapping over the kind's own reading of them (see mapping.ts), or by the author's converter. A source of a
 * kind not here fails its sync with `adapter-unavailable`.
 */
import type { SourceConfig } from '@shared/types';
import type { NormalizedRecord, SyncFailure } from './protocol';
import type { Transport } from './transport';

/** A reader's reason for failing, from the fixed list the main process puts in words; `detail` is kept short and is taken out of nothing. */
export class AdapterError extends Error {
  constructor(
    public readonly code: SyncFailure,
    public readonly detail?: string
  ) {
    super(code);
  }
}

/** Where the hosted services are asked, which tests point at a server of their own. */
export interface AdapterEnv {
  endpoints?: { contentful?: string; sanity?: string };
}

export interface ReadContext {
  config: SourceConfig;
  /** The secrets the settings name, by name. */
  secrets: Readonly<Record<string, string>>;
  signal: AbortSignal;
  /** The source's own server, and only it. */
  transport: Transport;
  env: AdapterEnv;
}

export interface SourceAdapter {
  /**
   * The one origin its server is at, from its settings: every request of a sync (pages, redirects, a converter's own)
   * goes there and nowhere else.
   */
  origin?(config: SourceConfig, env: AdapterEnv): string;
  /** The headers every request carries: its credentials, filled in. */
  headers?(config: SourceConfig, secrets: Readonly<Record<string, string>>): Record<string, string>;
  /**
   * Every record the source has, as it sent them (with links between them resolved), read in full. A read that fails
   * part way (a page of results that would not load) rejects, so no record ever looks removed because it was not read.
   */
  items?(ctx: ReadContext): Promise<unknown[]>;
  /** A reader that puts its records in shape itself (a test's fixture). */
  read?(config: SourceConfig, secrets: Readonly<Record<string, string>>, signal: AbortSignal): Promise<NormalizedRecord[]>;
}
