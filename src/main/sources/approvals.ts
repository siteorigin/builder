/**
 * Which settings of a source the user has approved to sign in with their secrets: what Save in Connect external source
 * tested and saved, kept in a file of the user's own (`userData/source-approvals.json`), never the project's. A
 * source's settings travel with the project and can be changed outside the app (a collaborator's commit, a hand edit):
 * settings no one approved here, an address that takes the user's secret somewhere else, never sign in with it.
 *
 * What is approved is what decides where and how a secret is sent: the kind of source, its settings and its converter.
 * Its name, mapping and removal policy may change outside the app without asking again.
 *
 * Kept by project and by the folder it is in, as its secrets are (secrets.ts): settings approved in a copy of the
 * project in another folder never sign in with the original's secrets (#1543).
 */
import { promises as fs } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { SourceDoc } from '@shared/types';
import { sourceFingerprint } from '@shared/sources';
import { atomicWrite } from '../project/fsutil';

/** Approved fingerprints by project ID, then the project's folder (canonical), then source ID, newest first. */
type ApprovalFile = Record<string, Record<string, Record<string, string[]>>>;

/** How many approved versions of a source's settings are kept, so an undo of a change to them still signs in. */
const KEPT = 20;

/** The part of a source's settings that decides where and how its secrets are sent. */
export function sendingFingerprint(source: SourceDoc): string {
  return sourceFingerprint({ adapter: source.adapter, config: source.config, converter: source.converter?.code ?? null } as unknown as SourceDoc);
}

/** The approvals of the projects in one folder. */
export interface ApprovalStore {
  /** Approve `source`'s settings, as they are, for project `projectId` in this folder. */
  approve(projectId: string, source: SourceDoc): Promise<void>;
  /** Whether `source`'s settings, as they are, were approved for project `projectId` in this folder. */
  approved(projectId: string, source: SourceDoc): Promise<boolean>;
}

/** The user's approval file: the approvals of the projects in folder `dir` (canonical, as the project was opened). */
export interface ApprovalFileStore {
  in(dir: string): ApprovalStore;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function createApprovalStore(file: () => string): ApprovalFileStore {
  let writes: Promise<unknown> = Promise.resolve();
  /** The file as stored; one that cannot be read or is damaged approves nothing, and is written afresh by the next approval. */
  const read = async (): Promise<ApprovalFile> => {
    try {
      const parsed = JSON.parse(await fs.readFile(file(), 'utf8')) as unknown;
      const folder = (f: unknown) => isRecord(f) && Object.values(f).every((l) => Array.isArray(l) && l.every((fp) => typeof fp === 'string'));
      if (isRecord(parsed) && Object.values(parsed).every((p) => isRecord(p) && Object.entries(p).every(([dir, f]) => isAbsolute(dir) && folder(f)))) return parsed as ApprovalFile;
    } catch {
      // None.
    }
    return {};
  };
  const of = (all: ApprovalFile, projectId: string, dir: string): Record<string, string[]> => {
    const folders = Object.hasOwn(all, projectId) ? all[projectId] : {};
    return Object.hasOwn(folders, dir) ? folders[dir] : {};
  };
  return {
    in(dir) {
      return {
        approve(projectId, source) {
          if (!projectId || !isAbsolute(dir)) return Promise.reject(new Error('An approval belongs to a project’s folder.'));
          const fp = sendingFingerprint(source);
          const write = writes.then(async () => {
            const all = await read();
            const mine = of(all, projectId, dir);
            const had = Object.hasOwn(mine, source.id) ? mine[source.id] : [];
            all[projectId] = { ...(Object.hasOwn(all, projectId) ? all[projectId] : {}), [dir]: { ...mine, [source.id]: [fp, ...had.filter((f) => f !== fp)].slice(0, KEPT) } };
            await atomicWrite(file(), JSON.stringify(all), { mode: 0o600 });
          });
          writes = write.catch(() => undefined);
          return write;
        },
        async approved(projectId, source) {
          await writes.catch(() => undefined);
          const mine = of(await read(), projectId, dir);
          return (Object.hasOwn(mine, source.id) ? mine[source.id] : []).includes(sendingFingerprint(source));
        }
      };
    }
  };
}
