import { app } from 'electron';
import { existsSync, promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import type { AppSettings, LocalCheck, SettingsPatch, ProviderId, ProviderStatus, RecentProject } from '@shared/api';
import { PROVIDER_LABELS } from '@shared/turn-model';
import { atomicWrite } from './project/fsutil';
import { canonicalDir } from '../runtime/policy';
import { PROVIDER_MODELS } from '@agent/models';
import type { LocalEndpoint } from '@agent/local';
import { checkLocalBaseURL, DEFAULT_LOCAL_SETTINGS, localContextWindow, localKeyProblem, localModelFor, localServerKey, type LocalProviderSettings } from '@shared/local';

interface SettingsFile {
  settings: AppSettings;
  recents: RecentProject[];
  trusted: Record<string, string>;
}

const DEFAULTS: SettingsFile = {
  settings: {
    appearance: 'system',
    developerMode: false,
    ai: {
      provider: 'openai',
      // No local model is preselected: the running server says what it offers.
      models: { openai: PROVIDER_MODELS.openai[0].id, anthropic: PROVIDER_MODELS.anthropic[0].id, local: '' },
      local: DEFAULT_LOCAL_SETTINGS,
      sendOnEnter: true,
      setupAcknowledged: false
    }
  },
  recents: [],
  trusted: {}
};

let cache: SettingsFile | null = null;
/**
 * What this app session last learned about each local server and the model chosen on it ('' for its first model),
 * with the model a request actually used (`resolved`). Kept in memory only: a server that was down yesterday may be
 * running now. `checkEpoch` moves when the server key changes, so a request made with the old key records nothing.
 */
const localChecks = new Map<string, { check: LocalCheck; resolved: string }>();
let checkEpoch = 0;
const checkKey = (server: string, model: string) => `${server}\n${model}`;

/** The settings file was there but could not be read at start: what is in memory may not be what is on disk. */
let unread = false;
const file = () => join(app.getPath('userData'), 'settings.json');

/**
 * Per-server choices as read from disk, each under its normalized address. Only models given as text are kept,
 * and an empty one is the same as none: the server's first model.
 */
function modelMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [server, id] of Object.entries(value)) {
    const key = localServerKey(server);
    if (key && typeof id === 'string' && id) out[key] = id;
  }
  return out;
}

/**
 * The local model in `ai.models.local` is always the one chosen for the saved server, read from the per-server
 * choices, so everything that reads it (chat, the connection test, the composer) follows a change of server.
 */
function withLocalModel(ai: AppSettings['ai']): AppSettings['ai'] {
  return { ...ai, models: { ...ai.models, local: localModelFor(ai.local) } };
}

export async function loadSettings(): Promise<SettingsFile> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(await fs.readFile(file(), 'utf8')) as Partial<SettingsFile>;
    const rawLocal: Partial<LocalProviderSettings> | undefined = raw.settings?.ai?.local;
    const local = { ...DEFAULTS.settings.ai.local, ...rawLocal, modelsByServer: modelMap(rawLocal?.modelsByServer) };
    // Settings from before models were kept per server hold one local model, chosen for the server saved with it.
    const legacy = raw.settings?.ai?.models?.local;
    const legacyServer = localServerKey(local.baseURL);
    if (rawLocal?.modelsByServer === undefined && typeof legacy === 'string' && legacy && legacyServer) local.modelsByServer = { [legacyServer]: legacy };
    cache = {
      settings: { ...DEFAULTS.settings, ...raw.settings, ai: withLocalModel({ ...DEFAULTS.settings.ai, ...raw.settings?.ai, models: { ...DEFAULTS.settings.ai.models, ...raw.settings?.ai?.models }, local }) },
      recents: raw.recents ?? [],
      trusted: raw.trusted ?? {}
    };
    // A hand-edited file can hold any value; one that is not a usable size means automatic.
    cache.settings.ai.local.contextWindow = localContextWindow(cache.settings.ai.local.contextWindow);
  } catch (e) {
    unread = (e as NodeJS.ErrnoException).code !== 'ENOENT';
    cache = structuredClone(DEFAULTS);
  }
  return cache;
}

let writes: Promise<void> = Promise.resolve();
/** Recent-project renames made in the settings, and how many of them a finished write has put on disk. */
let renames = 0;
let renamesSaved = 0;

/** One write at a time, each of the latest state, so an older save can never land after a newer one. */
export function saveSettings(): Promise<void> {
  const run = writes.then(async () => {
    if (!cache) return;
    const upTo = renames;
    await atomicWrite(file(), JSON.stringify(cache, null, 2));
    renamesSaved = Math.max(renamesSaved, upTo);
  });
  writes = run.catch(() => undefined);
  return run;
}

export async function updateSettings(patch: SettingsPatch): Promise<AppSettings> {
  const s = await loadSettings();
  // Null clears the context size back to automatic; any other value that is not a usable size is refused, so a
  // bad value never erases the one in use.
  const asked = patch.ai?.local;
  if (asked && 'contextWindow' in asked && asked.contextWindow !== null && localContextWindow(asked.contextWindow) === null) {
    const { contextWindow: _refused, ...rest } = asked;
    patch = { ...patch, ai: { ...patch.ai, local: rest } };
  }
  const prev = s.settings.ai;
  const local = { ...prev.local, ...(patch.ai?.local ?? {}), modelsByServer: { ...prev.local.modelsByServer } };
  const choose = (server: string | null, id: unknown) => {
    if (!server) return;
    if (typeof id === 'string' && id) local.modelsByServer[server] = id;
    else delete local.modelsByServer[server];
  };
  // A local model given on its own is chosen for the server this change leaves saved...
  const chosen = patch.ai?.models?.local;
  if (typeof chosen === 'string') choose(localServerKey(local.baseURL), chosen);
  // ...unless the change names that server's choice itself, which wins. Choices for named servers are added to the
  // ones kept; an empty one goes back to the server's first model.
  for (const [server, id] of Object.entries(patch.ai?.local?.modelsByServer ?? {})) choose(localServerKey(server), id);
  const models = { ...prev.models, ...(patch.ai?.models ?? {}) };
  s.settings = { ...s.settings, ...patch, ai: withLocalModel({ ...prev, ...(patch.ai ?? {}), models, local }) };
  s.settings.ai.local.contextWindow = localContextWindow(s.settings.ai.local.contextWindow);
  await saveSettings();
  return s.settings;
}

const MAX_RECENTS = 20;
const listedFolderGone = (dir: string) => !existsSync(join(dir, 'siteorigin.project.json'));

/**
 * Whether a project just opened is the one a recent entry listed (#217). An entry remembers its project's ID; one
 * listed before IDs were kept is matched by its name and its folder's name together, since a folder that has gone can
 * no longer be asked for its ID.
 */
function sameProject(old: RecentProject, opened: RecentProject): boolean {
  if (old.projectId) return old.projectId === opened.projectId;
  return old.name === opened.name && basename(old.dir) === basename(opened.dir);
}

/**
 * Lists a project folder as the one opened last. `replaces` is the missing entry the author chose this folder for
 * (Find folder… on its card, #217): it is dropped when this is the same project and its old folder is still not
 * there, in the same save, so the list never shows both. Any other project leaves that entry as it was, never
 * pushed off the end of the list by this opening.
 */
export async function addRecent(dir: string, name: string, projectId: string, replaces?: string) {
  const s = await loadSettings();
  const entry: RecentProject = { dir, name, openedAt: new Date().toISOString(), projectId };
  // An older entry may name the same folder through a link.
  const real = canonicalDir(dir);
  let rest = s.recents.filter((r) => r.dir !== dir && canonicalDir(r.dir) !== real);
  const old = replaces === undefined ? undefined : rest.find((r) => r.dir === replaces);
  if (old && listedFolderGone(old.dir) && sameProject(old, entry)) rest = rest.filter((r) => r !== old);
  else if (old && rest.indexOf(old) >= MAX_RECENTS - 1) rest = [...rest.filter((r) => r !== old).slice(0, MAX_RECENTS - 2), old];
  s.recents = [entry, ...rest].slice(0, MAX_RECENTS);
  await saveSettings();
}

/**
 * Gives the recent entry of a project folder its site's current name (#31), keeping its place and the time it was
 * opened: a rename is no new opening. A folder not on the list stays off it.
 */
export async function renameRecent(dir: string, name: string) {
  const s = await loadSettings();
  const real = canonicalDir(dir);
  const at = s.recents.findIndex((r) => r.dir === dir || canonicalDir(r.dir) === real);
  if (at < 0) return;
  if (s.recents[at].name !== name) {
    s.recents = s.recents.map((r, i) => (i === at ? { ...r, name } : r));
    renames++;
  }
  // Nothing to write, or wait for, once every rename is on disk: closing a project never waits on the disk for nothing
  // (or on another setting's write). A rename whose write failed, or has not finished, is written again.
  else if (renamesSaved >= renames) return;
  await saveSettings();
}

export async function recents(): Promise<RecentProject[]> {
  const s = await loadSettings();
  return s.recents.map((r) => ({ ...r, missing: listedFolderGone(r.dir) }));
}

export async function removeRecent(dir: string) {
  const s = await loadSettings();
  s.recents = s.recents.filter((r) => r.dir !== dir);
  await saveSettings();
}

export async function isTrusted(dir: string, configHash: string): Promise<boolean> {
  const s = await loadSettings();
  return s.trusted[dir] === configHash;
}

export async function trust(dir: string, configHash: string) {
  const s = await loadSettings();
  s.trusted[dir] = configHash;
  await saveSettings();
}

/** Folders whose trust was forgotten in memory but not yet on disk (the save failed). */
const unsavedUntrust = new Set<string>();

/**
 * Forget any trust given to `dir`: a new folder there (a project just unpacked) asks again before its tools run. The
 * settings are saved when a record goes, and again for a removal whose save failed earlier, so the old record cannot
 * come back after a restart. Settings that could not be read at start are neither overwritten nor trusted to hold no
 * record: that is refused.
 */
export async function untrust(dir: string) {
  const s = await loadSettings();
  if (unread) throw new Error('SiteOrigin Builder could not read its settings when it started. Restart it, then try again.');
  if (!(dir in s.trusted) && !unsavedUntrust.has(dir)) return;
  delete s.trusted[dir];
  unsavedUntrust.add(dir);
  await saveSettings();
  unsavedUntrust.delete(dir);
}

// ---------------------------------------------------------------------------
// Credentials: kept in a local file readable only by the current user account. The app never uses the
// operating system keychain, so it never asks for keychain access. Never written to projects, logs or exports.
// ---------------------------------------------------------------------------

const credFile = () => join(app.getPath('userData'), 'api-keys.json');
// A cloud provider's key is never sent to a local server, so the local provider has no environment fallback.
const ENV_KEYS: Partial<Record<ProviderId, string>> = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };

async function readStoredKeys(): Promise<Partial<Record<ProviderId, string>>> {
  try {
    return JSON.parse(await fs.readFile(credFile(), 'utf8'));
  } catch {
    return {};
  }
}

export async function setKey(provider: ProviderId, key: string | null) {
  // Checked before anything is read or written, so a refused key leaves the saved one as it was.
  const problem = provider === 'local' && key ? localKeyProblem(key) : null;
  if (problem) throw new Error(problem);
  const keys = await readStoredKeys();
  if (key) keys[provider] = key.trim();
  else delete keys[provider];
  // Created with 0600 before the rename, so the keys are never briefly readable by other accounts.
  await atomicWrite(credFile(), JSON.stringify(keys), { mode: 0o600 });
  // What the server said with the old key says nothing about the new one.
  if (provider === 'local') {
    localChecks.clear();
    checkEpoch++;
  }
}

/** Development builds may use provider keys from the environment as a documented override. */
function envKey(provider: ProviderId): string | undefined {
  const name = ENV_KEYS[provider];
  if (app.isPackaged || !name) return undefined;
  return process.env[name] || undefined;
}

export async function getKey(provider: ProviderId): Promise<{ key: string; source: ProviderStatus['source'] } | null> {
  const stored = (await readStoredKeys())[provider];
  if (stored) return { key: stored, source: 'stored' };
  const env = envKey(provider);
  if (env) return { key: env, source: 'environment' };
  return null;
}

export async function providerStatuses(): Promise<ProviderStatus[]> {
  const out: ProviderStatus[] = [];
  for (const id of ['openai', 'anthropic'] as ProviderId[]) {
    const k = await getKey(id);
    out.push({
      id,
      label: PROVIDER_LABELS[id],
      configured: !!k,
      source: k?.source ?? null,
      storage: 'local-file',
      models: PROVIDER_MODELS[id]
    });
  }
  // A local server needs no key: it is ready to try once its address is acceptable.
  const { local } = (await loadSettings()).settings.ai;
  const url = checkLocalBaseURL(local.baseURL, local.allowRemote);
  const key = await getKey('local');
  out.push({
    id: 'local',
    label: PROVIDER_LABELS.local,
    configured: url.ok,
    source: key?.source ?? null,
    storage: 'local-file',
    models: [],
    ...(url.ok && url.remote ? { warning: `Project content is sent to ${new URL(url.url).host}, which is not this computer.` } : {}),
    ...(url.ok && localChecks.has(checkKey(url.url, localModelFor(local))) ? { check: localChecks.get(checkKey(url.url, localModelFor(local)))!.check } : {})
  });
  return out;
}

/**
 * The saved local server. A model server the app runs itself can supply the same shape without Settings. `ai` is
 * the settings already read for this request, so the provider and the model come from the same reading.
 */
export async function localEndpoint(ai?: AppSettings['ai']): Promise<LocalEndpoint> {
  const { local } = ai ?? (await loadSettings()).settings.ai;
  return { baseURL: local.baseURL, allowRemote: local.allowRemote, toolMode: local.toolMode, contextWindow: local.contextWindow, model: localModelFor(local), apiKey: (await getKey('local'))?.key ?? null };
}

/** Taken before the saved key is read, so a request made with a key replaced meanwhile records nothing. */
export const localCheckEpoch = () => checkEpoch;

/**
 * A recorder for what requests to one server and chosen model show. Each server and model keeps its own last check,
 * so a late answer about one never replaces what is known about another, and a recorder made before the server key
 * changed records nothing. A model list that reads fine shows the server is there, not that the model can chat: it
 * clears only a failure to reach the server or find the model on it, and, for the server's first model, a check of a
 * model that is no longer first. A chat request or a connection test that worked clears any failure.
 */
export function localCheckRecorder(at: { baseURL: string; model: string }, epoch = checkEpoch) {
  const server = localServerKey(at.baseURL);
  return (check: LocalCheck | { listed: string[] }, resolved = at.model) => {
    if (!server || epoch !== checkEpoch) return;
    const key = checkKey(server, at.model);
    if (!('listed' in check)) {
      localChecks.set(key, { check, resolved });
      return;
    }
    const known = localChecks.get(key);
    if (!known) return;
    const moved = !at.model && known.resolved !== check.listed[0];
    if (moved || (!known.check.ok && known.check.stage === 'server')) localChecks.delete(key);
  };
}
