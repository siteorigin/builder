/**
 * Which settings of a source the user has approved to sign in with their secrets: what Save in Connect external source
 * tested and saved, kept in a file of the user's own (`userData/source-approvals.json`), never the project's. A
 * source's settings travel with the project and can be changed outside the app (a collaborator's commit, a hand edit):
 * settings no one approved here, an address that takes the user's secret somewhere else, never sign in with it.
 *
 * What is approved is what decides where and how a secret is sent: the kind of source, its settings and its converter.
 * Its name, mapping and removal policy may change outside the app without asking again.
 */
import { promises as fs } from 'node:fs';
import type { SourceDoc } from '@shared/types';
import { sourceFingerprint } from '@shared/sources';
import { atomicWrite } from '../project/fsutil';

/** Approved fingerprints by project ID, then source ID, newest first. */
type ApprovalFile = Record<string, Record<string, string[]>>;

/** How many approved versions of a source's settings are kept, so an undo of a change to them still signs in. */
const KEPT = 20;

/** The part of a source's settings that decides where and how its secrets are sent. */
export function sendingFingerprint(source: SourceDoc): string {
  return sourceFingerprint({ adapter: source.adapter, config: source.config, converter: source.converter?.code ?? null } as unknown as SourceDoc);
}

export interface ApprovalStore {
  /** Approve `source`'s settings, as they are, for project `projectId`. */
  approve(projectId: string, source: SourceDoc): Promise<void>;
  /** Whether `source`'s settings, as they are, were approved for project `projectId`. */
  approved(projectId: string, source: SourceDoc): Promise<boolean>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function createApprovalStore(file: () => string): ApprovalStore {
  let writes: Promise<unknown> = Promise.resolve();
  /** The file as stored; one that cannot be read or is damaged approves nothing, and is written afresh by the next approval. */
  const read = async (): Promise<ApprovalFile> => {
    try {
      const parsed = JSON.parse(await fs.readFile(file(), 'utf8')) as unknown;
      if (isRecord(parsed) && Object.values(parsed).every((p) => isRecord(p) && Object.values(p).every((l) => Array.isArray(l) && l.every((f) => typeof f === 'string')))) return parsed as ApprovalFile;
    } catch {
      // None.
    }
    return {};
  };
  return {
    approve(projectId, source) {
      const fp = sendingFingerprint(source);
      const write = writes.then(async () => {
        const all = await read();
        const mine = Object.hasOwn(all, projectId) ? all[projectId] : {};
        const had = Object.hasOwn(mine, source.id) ? mine[source.id] : [];
        all[projectId] = { ...mine, [source.id]: [fp, ...had.filter((f) => f !== fp)].slice(0, KEPT) };
        await atomicWrite(file(), JSON.stringify(all), { mode: 0o600 });
      });
      writes = write.catch(() => undefined);
      return write;
    },
    async approved(projectId, source) {
      await writes.catch(() => undefined);
      const all = await read();
      const list = Object.hasOwn(all, projectId) && Object.hasOwn(all[projectId], source.id) ? all[projectId][source.id] : [];
      return list.includes(sendingFingerprint(source));
    }
  };
}
