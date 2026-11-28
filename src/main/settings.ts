import { app } from 'electron';
import { promises as fs, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AppSettings, LocalCheck, SettingsPatch, ProviderId, ProviderStatus, RecentProject } from '@shared/api';
import { PROVIDER_LABELS } from '@shared/turn-model';
import { BRIEF_FILE, storedBriefDescription } from '@shared/brief';
import { APPLE_TOUCH_ICON } from '@shared/site-icons';
import { atomicWrite } from './project/fsutil';
import { canonicalDir } from '../runtime/policy';
import { PROVIDER_MODELS } from '@agent/models';
import type { LocalEndpoint } from '@agent/local';
import { DEFAULT_SHORTCUTS, normalShortcut, shortcutConflict, type ShortcutSettings } from '@shared/shortcuts';
import { checkLocalBaseURL, DEFAULT_LOCAL_SETTINGS, localContextWindow, localKeyProblem, localModelFor, localServerKey, type LocalProviderSettings } from '@shared/local';
import { checkRelayUrl } from '@shared/live/relay-url';
import type { ExternalEditor } from '@shared/code-workspace';
import { storedEditor } from './external-editor';

interface SettingsFile {
  settings: AppSettings;
  recents: RecentEntry[];
  trusted: Record<string, string>;
  /** The folder the last new project was created in, so the next New project proposes it. */
  lastProjectParent?: string;
  /** The author hid Get started (shared/first-steps) in a project: new Business sites open without it. */
  getStartedHidden?: boolean;
}

const DEFAULTS: SettingsFile = {
  settings: {
    appearance: 'system',
    developerMode: false,
    externalEditor: { kind: 'system' },
    gitSnapshots: false,
    liveRelayUrl: null,
    shortcuts: DEFAULT_SHORTCUTS,
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
 * Whether this run locks Developer mode off (`SITEORIGIN_DEVELOPER_MODE=locked-off`). The test driver sets it for a session
 * an external model drives: in Developer mode the preview runs code a person writes with the permissions of whoever runs
 * the app, which nothing driving the app from outside may reach. The setting then reads off, and asking for it changes
 * nothing.
 */
export function developerModeLocked(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SITEORIGIN_DEVELOPER_MODE === 'locked-off';
}
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

/** The shortcuts as read from disk: a binding a hand-edited file spoils, or one now taken, goes back to the default. */
function storedShortcuts(value: unknown): ShortcutSettings {
  const askAi = normalShortcut((value as Partial<ShortcutSettings> | undefined)?.askAi);
  return { askAi: askAi && !shortcutConflict(askAi, process.platform) ? askAi : DEFAULT_SHORTCUTS.askAi };
}

/** The shortcuts last written to disk (or read from it): what a failed save goes back to. */
let savedShortcuts: ShortcutSettings = DEFAULT_SHORTCUTS;

/** The shortcuts in use now, for key presses the main process sees before the editor does. */
export const currentShortcuts = (): ShortcutSettings => cache?.settings.shortcuts ?? DEFAULT_SHORTCUTS;

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
      settings: { ...DEFAULTS.settings, ...raw.settings, shortcuts: storedShortcuts(raw.settings?.shortcuts), ai: withLocalModel({ ...DEFAULTS.settings.ai, ...raw.settings?.ai, models: { ...DEFAULTS.settings.ai.models, ...raw.settings?.ai?.models }, local }) },
      recents: raw.recents ?? [],
      trusted: raw.trusted ?? {},
      ...(typeof raw.lastProjectParent === 'string' && raw.lastProjectParent ? { lastProjectParent: raw.lastProjectParent } : {}),
      ...(raw.getStartedHidden === true ? { getStartedHidden: true } : {})
    };
    savedShortcuts = cache.settings.shortcuts;
    // A hand-edited file can hold any value; one that is not a usable size means automatic.
    cache.settings.ai.local.contextWindow = localContextWindow(cache.settings.ai.local.contextWindow);
    // A relay address that is not text is none. Text that is not a usable address is kept, so starting a live session
    // reports it rather than quietly using the production relay.
    if (typeof cache.settings.liveRelayUrl !== 'string' || !cache.settings.liveRelayUrl.trim()) cache.settings.liveRelayUrl = null;
    // Only a hand-edited true turns Git snapshots on: anything else is the default, off.
    cache.settings.gitSnapshots = cache.settings.gitSnapshots === true;
    // An editor that is not a usable choice is the system's default.
    cache.settings.externalEditor = storedEditor(cache.settings.externalEditor);
  } catch (e) {
    unread = (e as NodeJS.ErrnoException).code !== 'ENOENT';
    // Kept in the main process's log (main-log.ts): settings that could not be read start from the defaults.
    if (unread) console.warn('The settings could not be read, so the defaults are in use:', e);
    cache = structuredClone(DEFAULTS);
  }
  if (developerModeLocked()) cache.settings.developerMode = false;
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
    const shortcuts = cache.settings.shortcuts;
    await atomicWrite(file(), JSON.stringify(cache, null, 2));
    savedShortcuts = shortcuts;
    renamesSaved = Math.max(renamesSaved, upTo);
  });
  writes = run.catch(() => undefined);
  return run;
}

export async function updateSettings(patch: SettingsPatch): Promise<AppSettings> {
  const s = await loadSettings();
  // A shortcut is checked before anything changes, so a refused one leaves every setting as it was.
  let shortcuts = s.settings.shortcuts;
  if (patch.shortcuts && 'askAi' in patch.shortcuts) {
    const askAi = normalShortcut(patch.shortcuts.askAi);
    const problem = shortcutConflict(askAi ?? '', process.platform);
    if (problem || !askAi) throw new Error(problem ?? 'That is not a shortcut SiteOrigin Builder can use.');
    shortcuts = { ...shortcuts, askAi };
  }
  // Null clears the context size back to automatic; any other value that is not a usable size is refused, so a
  // bad value never erases the one in use.
  const asked = patch.ai?.local;
  if (asked && 'contextWindow' in asked && asked.contextWindow !== null && localContextWindow(asked.contextWindow) === null) {
    const { contextWindow: _refused, ...rest } = asked;
    patch = { ...patch, ai: { ...patch.ai, local: rest } };
  }
  // A relay address is kept in its normal form; null or a blank one goes back to the production relay, and anything
  // that cannot be used is refused, keeping the address saved before.
  if ('liveRelayUrl' in patch) {
    const { liveRelayUrl: asked, ...rest } = patch;
    const cleared = asked === null || (typeof asked === 'string' && !asked.trim());
    const relay = cleared ? null : checkRelayUrl(asked);
    patch = relay === null ? { ...rest, liveRelayUrl: null } : relay.ok ? { ...rest, liveRelayUrl: relay.url } : rest;
  }
  // Git snapshots are on or off: any other value is refused, keeping the one in use.
  if ('gitSnapshots' in patch && typeof patch.gitSnapshots !== 'boolean') {
    const { gitSnapshots: _refused, ...rest } = patch;
    patch = rest;
  }
  // The editor goes back to the system's default this way; an application is chosen only through setExternalEditor,
  // which checks it is one, so nothing the editor window sends can name a program to start.
  if ('externalEditor' in patch) {
    const { externalEditor: asked, ...rest } = patch;
    patch = (asked as { kind?: unknown } | undefined)?.kind === 'system' ? { ...rest, externalEditor: { kind: 'system' } } : rest;
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
  s.settings = { ...s.settings, ...patch, shortcuts, ai: withLocalModel({ ...prev, ...(patch.ai ?? {}), models, local }) };
  s.settings.ai.local.contextWindow = localContextWindow(s.settings.ai.local.contextWindow);
  if (developerModeLocked()) s.settings.developerMode = false;
  try {
    await saveSettings();
  } catch (e) {
    // A shortcut that could not be saved is not taken up: the keys go back to the last ones on disk, as Settings still
    // shows them (unless a later change has set others since, whose own save decides).
    if (s.settings.shortcuts === shortcuts) s.settings.shortcuts = savedShortcuts;
    throw e;
  }
  return s.settings;
}

/** Use `editor`, an application checked by external-editor.ts checkEditorApp, as the code editor from now on. */
export async function setExternalEditor(editor: ExternalEditor): Promise<AppSettings> {
  const s = await loadSettings();
  s.settings = { ...s.settings, externalEditor: storedEditor(editor) };
  await saveSettings();
  return s.settings;
}

/**
 * A recent project as the settings keep it. `folderId` is the folder's identity on its disk (device and inode) when it
 * was last opened, which a move or rename keeps and a copy does not: it tells a moved folder already listed on its own
 * from another working copy of the same project when the author finds where a missing entry went (#1541). It stays in
 * the main process.
 */
type RecentEntry = RecentProject & { folderId?: string };

const MAX_RECENTS = 20;
const MANIFEST = 'siteorigin.project.json';

/**
 * Whether a listed project's folder is known to be gone: nothing at its path. A folder that cannot be looked into
 * right now (no permission, say) is not known to be gone, so its entry is never given away for it.
 */
function listedFolderGone(dir: string): boolean {
  try {
    statSync(join(dir, MANIFEST));
    return false;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
}

/**
 * Whether a project just opened is the one a recent entry listed (#217), by the project ID the entry remembers. An
 * entry listed before IDs were kept can never be told apart from another project of its name (a project's folder is
 * named after it), so nothing replaces it: it stays until it is removed.
 */
function sameProject(old: RecentProject, opened: RecentProject): boolean {
  return typeof old.projectId === 'string' && old.projectId !== '' && old.projectId === opened.projectId;
}

/**
 * A folder's identity on its disk (device and inode), or undefined when it cannot be looked at. A move or rename on the
 * same disk keeps it; a copy of the project (an editable ZIP opened again, a Finder duplicate) is a new folder with its
 * own (#1541). A file system with no file IDs to give (Windows reports none as 0 or all bits set) tells nothing.
 */
function folderIdentity(dir: string): string | undefined {
  try {
    const st = statSync(dir, { bigint: true, throwIfNoEntry: false });
    if (!st?.isDirectory() || st.ino === 0n || st.ino === 0xffffffffffffffffn) return undefined;
    return `${st.dev}:${st.ino}`;
  } catch {
    return undefined;
  }
}

/**
 * The list as it is kept: every pinned project (#259), and the newest MAX_RECENTS of the rest, so a project pinned
 * long ago is never rotated off by others opened since. `keep` is an entry this opening may not push off the end
 * (#217): it holds one of the places, and the newest of the others fill the rest.
 */
function capped(list: RecentEntry[], keep?: RecentEntry): RecentEntry[] {
  let room = MAX_RECENTS - (keep && keep.pinned !== true ? 1 : 0);
  return list.filter((r) => r.pinned === true || r === keep || room-- > 0);
}

/** An entry with its pin as given; an unpinned one carries no flag at all, as entries listed before pins did. */
function withPin<T extends RecentProject>(r: T, pinned: boolean): T {
  const { pinned: _was, ...rest } = r;
  return (pinned ? { ...rest, pinned: true } : rest) as T;
}

/**
 * Lists a project folder as the one opened last. `replaces` is the missing entry the author chose this folder for
 * (Find folder… on its card, #217): it is dropped when this is the same project and its old folder is still not
 * there, in the same save, so the list never shows both. A folder that already had its own entry takes it over only
 * when it is that entry's own folder, moved (#1541): another working copy of the same project (an editable ZIP opened
 * into two folders keeps its ID) is a separate workspace, and the missing entry keeps its place and its pin. Any other
 * project leaves that entry as it was, never pushed off the end of the list by this opening. A pinned project stays pinned when it is opened again, and when
 * its moved folder takes over its missing entry (#259); opening it takes no other project off the list.
 */
export async function addRecent(dir: string, name: string, projectId: string, replaces?: string) {
  const s = await loadSettings();
  // An older entry may name the same folder through a link: each entry's folder is resolved once, so the entries
  // dropped are exactly the ones whose pin is looked at.
  const real = canonicalDir(dir);
  const same = s.recents.filter((r) => r.dir === dir || canonicalDir(r.dir) === real);
  let rest = s.recents.filter((r) => !same.includes(r));
  const folderId = folderIdentity(dir);
  const entry: RecentEntry = { dir, name, openedAt: new Date().toISOString(), projectId, ...(folderId ? { folderId } : {}) };
  // The pin stays with its project: another project put in a pinned project's old folder is not pinned for it. An
  // entry listed before IDs were kept cannot be told apart, so its pin is kept.
  let pinned = same.some((r) => r.pinned === true && (typeof r.projectId !== 'string' || r.projectId === '' || r.projectId === projectId));
  let old = replaces === undefined ? undefined : rest.find((r) => r.dir === replaces);
  // Listed already, this folder is the missing entry's only when it is the very folder that entry was listed with.
  const itsOwn = same.length === 0 || (folderId !== undefined && old?.folderId === folderId);
  if (old && listedFolderGone(old.dir) && sameProject(old, entry) && itsOwn) {
    pinned ||= old.pinned === true;
    rest = rest.filter((r) => r !== old);
    old = undefined;
  }
  // A pinned project opened again takes no other project's place, even one an unpin has left past the end.
  s.recents = pinned ? [withPin(entry, true), ...rest] : capped([entry, ...rest], old);
  await saveSettings();
}

/** Remembers the folder a new project was just created in. */
export async function rememberProjectParent(parent: string) {
  const s = await loadSettings();
  s.lastProjectParent = parent;
  await saveSettings();
}

/** Hiding Get started in a project hides it for the projects made after it too; Undo brings both back. */
export async function rememberGetStartedHidden(hidden: boolean) {
  const s = await loadSettings();
  if (!!s.getStartedHidden === hidden) return;
  if (hidden) s.getStartedHidden = true;
  else delete s.getStartedHidden;
  await saveSettings();
}

/** The folder the last new project was created in, when it is still a folder. */
export async function usableProjectParent(): Promise<string | undefined> {
  const last = (await loadSettings()).lastProjectParent;
  if (!last) return undefined;
  try {
    return (await fs.stat(last)).isDirectory() ? last : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pins a listed project folder, or unpins it (#259). A pinned project stays listed however many others are opened
 * after it; unpinned, it takes its place among the rest by when it was last opened again, and goes once newer ones
 * fill the list. A folder not on the list stays off it: the answer says whether it was listed.
 */
export async function pinRecent(dir: string, pinned: boolean): Promise<boolean> {
  const s = await loadSettings();
  const at = s.recents.findIndex((r) => r.dir === dir);
  if (at < 0) return false;
  const was = s.recents[at].pinned === true;
  if (was !== pinned) s.recents = s.recents.map((r, i) => (i === at ? withPin(r, pinned) : r));
  // Written even when the list already says so, so an answer never comes before the pin is on disk.
  try {
    await saveSettings();
  } catch (e) {
    // Not saved: the entry goes back as it was (unless a later pin or unpin has changed it since), so the list never
    // shows a pin a restart would lose, and the same request can be made again.
    if (was !== pinned) s.recents = s.recents.map((r) => (r.dir === dir && (r.pinned === true) === pinned ? withPin(r, was) : r));
    throw e;
  }
  return true;
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
  // Only a pin given as one counts: a hand-edited file can hold anything.
  return Promise.all(
    s.recents.map(async ({ folderId: _kept, ...r }) => {
      // Checked without blocking: a folder on a share that has stopped answering holds up this card, never every request.
      const missing = !(await fs.access(join(r.dir, MANIFEST)).then(() => true, () => false));
      // Read from the folder each time, so a card says what the project's brief says now, however it was changed.
      const [description, icon] = missing ? ['', ''] : await Promise.all([briefDescription(r.dir), siteIcon(r.dir)]);
      return { ...withPin(r, r.pinned === true), missing, ...(description ? { description } : {}), ...(icon ? { icon } : {}) };
    })
  );
}

/** The most of an icon a card reads: the 180px PNG every save draws is a small fraction of this. */
const MAX_ICON_BYTES = 256 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The site's home-screen icon in `dir` as a PNG data URL, or '' when there is none that can be used. Every save draws
 * it, opaque, from the favicon or the site's monogram (main/project/site-icons.ts), so a card shows the site as its
 * visitors' phones do. Only a regular file that starts as a PNG is read: not a link, not a folder, nothing oversized.
 */
async function siteIcon(dir: string): Promise<string> {
  try {
    const file = join(dir, 'static', APPLE_TOUCH_ICON);
    const st = await fs.lstat(file);
    if (!st.isFile() || st.size > MAX_ICON_BYTES) return '';
    const bytes = await fs.readFile(file);
    if (bytes.length > MAX_ICON_BYTES || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return '';
    return `data:image/png;base64,${bytes.toString('base64')}`;
  } catch {
    return '';
  }
}

/** The most of a brief a card reads: a brief within its limits is far smaller. */
const MAX_BRIEF_BYTES = 1024 * 1024;

/** The description of the project brief (#518) in `dir`, or '' when it has none, or none that can be read. */
async function briefDescription(dir: string): Promise<string> {
  try {
    const file = join(dir, BRIEF_FILE);
    const st = await fs.lstat(file);
    if (!st.isFile() || st.size > MAX_BRIEF_BYTES) return '';
    return storedBriefDescription(await fs.readFile(file, 'utf8'));
  } catch {
    return '';
  }
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

/** Whether `dir` was trusted before, with setup files it no longer has: asked about again as a change. */
export async function wasTrusted(dir: string): Promise<boolean> {
  const s = await loadSettings();
  return dir in s.trusted;
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

/**
 * Every provider key the app holds (stored, and a development build's from the environment), for a publication to be
 * searched for (#1154): never shown, logged or sent. A key file that is there but cannot be read rejects, rather than
 * passing as one with no keys.
 */
export async function keyValues(): Promise<string[]> {
  let text: string | null = null;
  try {
    text = await fs.readFile(credFile(), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Your API keys could not be read, so the website could not be checked for them.', { cause: e });
  }
  let stored: unknown = {};
  try {
    stored = text === null ? {} : JSON.parse(text);
  } catch {
    throw new Error('Your API keys file is damaged, so the website could not be checked for them. Save your keys again in Settings.');
  }
  const values = stored && typeof stored === 'object' ? Object.values(stored as Record<string, unknown>).filter((v): v is string => typeof v === 'string' && v !== '') : [];
  for (const provider of Object.keys(ENV_KEYS) as ProviderId[]) {
    const env = envKey(provider);
    if (env) values.push(env);
  }
  return values;
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
