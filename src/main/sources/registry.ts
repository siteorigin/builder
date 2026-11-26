/**
 * The kinds of source the sync worker can read, by the name a source's settings give (`adapter`). Each reads every
 * record its source has and puts each in the shape of an entry. None ships yet: the REST, GraphQL and CMS readers come
 * with their field mapping (#678). A source of a kind not here fails its sync with `adapter-unavailable`.
 */
import type { SourceConfig } from '@shared/types';
import type { NormalizedRecord, SyncFailure } from './protocol';

export interface SourceAdapter {
  /**
   * Every record the source has, read in full. A read that fails part way (a page of results that would not load)
   * rejects, so no record ever looks removed because it was not read. `secrets` are the ones the settings name.
   */
  read(config: SourceConfig, secrets: Readonly<Record<string, string>>, signal: AbortSignal): Promise<NormalizedRecord[]>;
}

/** A reader's reason for failing, from the fixed list the main process puts in words; `detail` is kept short and is taken out of nothing. */
export class AdapterError extends Error {
  constructor(
    public readonly code: SyncFailure,
    public readonly detail?: string
  ) {
    super(code);
  }
}

export const ADAPTERS: Readonly<Record<string, SourceAdapter>> = Object.freeze({});
