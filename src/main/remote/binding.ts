/**
 * Where a project is published to, and what is known of it (#1157): `.siteorigin/remote.json`, the editor's own state,
 * which no snapshot, publication, export, duplicate or ZIP file carries. It holds the remote binding (an opaque random
 * ID, the provider, the approved repository address and an optional site ID of the provider's), never a credential
 * (credentials.ts keeps those, by the binding's ID, outside the project), and three facts kept apart, since each can be
 * true without the others:
 *
 * - `content`: whether the website differs from the publication last prepared, as last looked at;
 * - `acknowledged`: the prepared commit the host last said its publication branch holds;
 * - `receipt`: what the provider last said of a commit going live (building, live, or failed), when it says anything,
 *   so an upload that landed and a build at the host that then failed are told apart from an upload that failed.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite } from '../project/fsutil';
import { approveEndpoint, OID_RE, type GitErrorCode, type Oid } from '../git/protocol';
import { BINDING_ID_RE } from './credentials';

/** The file, relative to the project's folder. */
export const REMOTE_STATE_FILE = '.siteorigin/remote.json';
/** Larger than any the app writes. */
const MAX_BYTES = 64 * 1024;

/** Who a project is published through: plain HTTPS Git now; SiteOrigin Hosting later, behind the same transport. */
export type RemoteProvider = 'https-git';
const PROVIDERS: readonly string[] = ['https-git'];

export interface RemoteBinding {
  id: string;
  provider: RemoteProvider;
  /** The approved repository address (approveEndpoint). */
  url: string;
  /** The provider's own name for the site, opaque to the app, or null. */
  site: string | null;
}

export type DeploymentStatus = 'building' | 'live' | 'failed';

export interface DeploymentReceipt {
  commit: Oid;
  status: DeploymentStatus;
  /** The provider's own name for the deployment, opaque to the app, or null. */
  id: string | null;
  at: string;
}

export interface RemoteState {
  binding: RemoteBinding;
  content: { prepared: Oid | null; changed: boolean; at: string } | null;
  acknowledged: { commit: Oid; at: string } | null;
  receipt: DeploymentReceipt | null;
}

export class RemoteStateError extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isOid = (v: unknown): v is Oid => typeof v === 'string' && OID_RE.test(v);
const isTime = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));
/** An opaque name of a provider's: one line, short, printable. */
// eslint-disable-next-line no-control-regex
export const opaqueOk = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\u0000-\u001f\u007f]/.test(v);

function urlOk(v: unknown): v is string {
  try {
    return typeof v === 'string' && approveEndpoint(v) === v;
  } catch {
    return false;
  }
}

export function receiptOk(r: unknown): r is DeploymentReceipt {
  return isRecord(r) && isOid(r.commit) && (['building', 'live', 'failed'] as unknown[]).includes(r.status) && (r.id === null || opaqueOk(r.id)) && isTime(r.at);
}

/** Whether `v` is a remote state as the app writes it. */
function stateOk(v: unknown): v is RemoteState {
  if (!isRecord(v)) return false;
  const b = v.binding;
  if (!isRecord(b) || typeof b.id !== 'string' || !BINDING_ID_RE.test(b.id) || !PROVIDERS.includes(b.provider as string) || !urlOk(b.url) || !(b.site === null || opaqueOk(b.site))) return false;
  const c = v.content;
  if (c !== null && !(isRecord(c) && (c.prepared === null || isOid(c.prepared)) && typeof c.changed === 'boolean' && isTime(c.at))) return false;
  const a = v.acknowledged;
  if (a !== null && !(isRecord(a) && isOid(a.commit) && isTime(a.at))) return false;
  return v.receipt === null || receiptOk(v.receipt);
}

/** The project's remote state, or null when it has no binding. A file there that is not one the app writes stops the read. */
export async function readRemoteState(dir: string): Promise<RemoteState | null> {
  const path = join(dir, ...REMOTE_STATE_FILE.split('/'));
  const st = await fs.lstat(path).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' || e.code === 'ENOTDIR' ? null : Promise.reject(e)));
  if (!st) return null;
  const damaged = () => new RemoteStateError('Where this project is published to could not be read. Connect it to its host again.');
  if (!st.isFile() || st.size > MAX_BYTES) throw damaged();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(path, 'utf8'));
  } catch {
    throw damaged();
  }
  if (!stateOk(parsed)) throw damaged();
  const { binding: b, content, acknowledged, receipt } = parsed;
  return { binding: { id: b.id, provider: b.provider, url: b.url, site: b.site }, content, acknowledged, receipt };
}

/** Write the project's remote state, or remove it (null). */
export async function writeRemoteState(dir: string, state: RemoteState | null): Promise<void> {
  const path = join(dir, ...REMOTE_STATE_FILE.split('/'));
  if (state === null) return fs.rm(path, { force: true });
  if (!stateOk(state)) throw new RemoteStateError('That is not a remote state the app writes.');
  await fs.mkdir(join(dir, '.siteorigin'), { recursive: true });
  await atomicWrite(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** Why a remote operation stopped, in the app's words (never a host's), and for a divergence or a conflict the commit there. */
export interface RemoteFailure {
  ok: false;
  code: GitErrorCode | 'not-bound' | 'not-prepared' | 'read-only' | 'closed';
  message: string;
  actual?: Oid | null;
}
/** The project's remote state as it now is (null: no binding), or why it could not be read or changed. */
export type RemoteResult = { ok: true; state: RemoteState | null } | RemoteFailure;
/** What pushing the prepared publication did. */
export type PushPublicationResult = { ok: true; commit: Oid; uploaded: boolean; reconciled: boolean } | RemoteFailure;
