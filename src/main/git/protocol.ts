/**
 * The project's versions repository (#1152): a bare Git repository at `.siteorigin/versions.git/`, written by the bundled
 * pure-JavaScript Git in a worker of its own (worker.ts), and what the main process and that worker say to each other.
 *
 * Nothing here names the Git that does the work: a repository is objects addressed by their SHA-1 and branches that
 * point at commits, in Git's own format, so a native Git (the computer's, or one downloaded later) could take the
 * worker's place and read and write the same repository without converting it. The user's own `.git/` is never part of it.
 */

/** A Git object's name: the SHA-1 of its content, as 40 lowercase hex digits. */
export type Oid = string;
export const OID_RE = /^[0-9a-f]{40}$/;

/** The repository, relative to the project's folder. */
export const VERSIONS_GITDIR = '.siteorigin/versions.git';
/** The branch a new repository's HEAD names; it exists once a commit is published to it. */
export const VERSIONS_BRANCH = 'refs/heads/siteorigin-versions';
/**
 * The branches the app writes: `refs/heads/siteorigin-` and a lowercase name (`siteorigin-versions`, and the publishing
 * history's `siteorigin-publish` later). No other ref is ever read or moved.
 */
export const BRANCH_RE = /^refs\/heads\/siteorigin-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Who made a commit and when: `timestamp` in seconds since 1970, `timezoneOffset` in minutes as JavaScript's
 * `Date.getTimezoneOffset` gives it (west of UTC is positive). Always given explicitly, so the repository never takes a
 * name, address or clock from the computer it is written on.
 */
export interface Identity {
  name: string;
  email: string;
  timestamp: number;
  timezoneOffset: number;
}

/**
 * One file of a tree, by its path in the tree (`siteorigin/site.json`): its bytes, or a project-relative file the worker
 * reads itself, so a large picture never passes through the main process.
 */
export type FileInput = { path: string; bytes: Uint8Array } | { path: string; source: string };
/** A blob's content, as for FileInput. */
export type BlobInput = { bytes: Uint8Array } | { source: string };

export interface TreeEntry {
  /** `100644` for a file, `100755` for one that can be run, `040000` for a folder. */
  mode: string;
  /** Its name in the tree. */
  path: string;
  oid: Oid;
  type: 'blob' | 'tree' | 'commit';
}

export interface CommitInput {
  tree: Oid;
  /** None for a first commit, and for the root of a history of its own. */
  parents: Oid[];
  author: Identity;
  committer: Identity;
  message: string;
}

export interface CommitInfo extends CommitInput {
  oid: Oid;
}

/**
 * How much one request may hold, so a folder of large media cannot exhaust the worker's memory or the disk with
 * a write that would then be refused. The bundled Git holds a whole object in memory, twice over while it is
 * compressed, so a blob is held well under what a worker can allocate; the image library stores files of 25 MiB at most.
 */
export interface GitLimits {
  /** One file. */
  maxBlobBytes: number;
  /** Every file of one tree written together. */
  maxTotalBytes: number;
  /** The bytes a request carries itself (documents), as opposed to files the worker reads. */
  maxInlineBytes: number;
  /** Files in one tree written together. */
  maxEntries: number;
  /** A path in a tree, in UTF-8 bytes. */
  maxPathBytes: number;
  /** Folders deep. */
  maxDepth: number;
  /** A commit's message, in UTF-8 bytes. */
  maxMessageBytes: number;
  /** Commits one listing returns. */
  maxLogDepth: number;
}

export const GIT_LIMITS: GitLimits = {
  maxBlobBytes: 64 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxInlineBytes: 64 * 1024 * 1024,
  maxEntries: 20_000,
  maxPathBytes: 1024,
  maxDepth: 32,
  maxMessageBytes: 64 * 1024,
  maxLogDepth: 1000
};

/**
 * Why a repository operation failed.
 * - `not-found`: no repository, object or branch there.
 * - `invalid`: the request itself is wrong (a path, a name, an identity).
 * - `too-large`: over a limit (GitLimits); nothing was written.
 * - `changed`: a file being read changed meanwhile; nothing was published.
 * - `conflict`: the branch was not where the caller expected (`actual` says where it is); it was not moved.
 * - `locked`: another writer holds the branch; it was not moved.
 * - `corrupt`: the repository is damaged or is not one the app made.
 * - `cancelled`, `timeout`: stopped before it finished; a branch was not moved.
 * - `outcome-unknown`: the worker stopped while it was moving a branch, which may or may not have moved: read it again.
 * - `crashed`, `stopped`, `busy`, `failed`: the worker went down, the app is quitting, too much is waiting, or anything else.
 */
export type GitErrorCode = 'not-found' | 'invalid' | 'too-large' | 'changed' | 'conflict' | 'locked' | 'corrupt' | 'cancelled' | 'timeout' | 'outcome-unknown' | 'crashed' | 'stopped' | 'busy' | 'failed';

export class GitError extends Error {
  constructor(
    public readonly code: GitErrorCode,
    message: string,
    /** For a conflict: the commit the branch is at, or null when it does not exist. */
    public readonly actual?: Oid | null
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * The repository of one project, as the rest of the app uses it. Every write is content-addressed and moves no branch:
 * only `advanceRef` publishes, and only from the commit the caller last saw.
 */
export interface GitRepository {
  /** Make the repository if it is not there yet; an existing one is checked, never replaced. */
  init(opts?: CallOptions): Promise<void>;
  /** Whether the repository exists. Creates nothing. */
  exists(opts?: CallOptions): Promise<boolean>;
  writeBlob(input: BlobInput, opts?: CallOptions): Promise<Oid>;
  /** Every file as one tree, its folders made from their paths; the root tree's name. */
  writeFiles(files: readonly FileInput[], opts?: CallOptions): Promise<Oid>;
  writeCommit(commit: CommitInput, opts?: CallOptions): Promise<Oid>;
  /** A blob's bytes, or with `filepath` the bytes of that file in the tree of commit or tree `oid`. */
  readBlob(oid: Oid, filepath?: string, opts?: CallOptions): Promise<Uint8Array>;
  readTree(oid: Oid, opts?: CallOptions): Promise<TreeEntry[]>;
  readCommit(oid: Oid, opts?: CallOptions): Promise<CommitInfo>;
  /** The branch's commits, newest first, at most `limit`; none when the branch does not exist. */
  listCommits(ref: string, limit: number, opts?: CallOptions): Promise<CommitInfo[]>;
  /** The commit a branch points at, or null when it does not exist. */
  resolveRef(ref: string, opts?: CallOptions): Promise<Oid | null>;
  /**
   * Point `ref` at commit `next`, only if it points at `expected` now (null: only if it does not exist yet). Rejects
   * with `conflict` (and the commit it is at) when it does not, and never retries by itself.
   */
  advanceRef(ref: string, next: Oid, expected: Oid | null, opts?: CallOptions): Promise<void>;
}

export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** One request to the worker: an operation on the repository of the project at `root`. */
export type GitOp =
  | { op: 'version' }
  | { op: 'init'; root: string }
  | { op: 'exists'; root: string }
  | { op: 'writeBlob'; root: string; input: BlobInput }
  | { op: 'writeFiles'; root: string; files: FileInput[] }
  | { op: 'writeCommit'; root: string; commit: CommitInput }
  | { op: 'readBlob'; root: string; oid: Oid; filepath?: string }
  | { op: 'readTree'; root: string; oid: Oid }
  | { op: 'readCommit'; root: string; oid: Oid }
  | { op: 'listCommits'; root: string; ref: string; limit: number }
  | { op: 'resolveRef'; root: string; ref: string }
  | { op: 'advanceRef'; root: string; ref: string; next: Oid; expected: Oid | null };

export type GitRequest = ({ id: number } & GitOp) | { id: number; op: 'cancel'; target: number };
export type GitReply = { id: number; ok: true; value: unknown } | { id: number; ok: false; code: GitErrorCode; message: string; actual?: Oid | null };

/** The bytes a request carries itself, counted against the limits before it is sent. */
export function inlineBytes(op: GitOp): number {
  if (op.op === 'writeBlob') return 'bytes' in op.input ? op.input.bytes.byteLength : 0;
  if (op.op === 'writeFiles') return op.files.reduce((n, f) => n + ('bytes' in f ? f.bytes.byteLength : 0), 0);
  return 0;
}
