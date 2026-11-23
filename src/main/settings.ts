import { app } from 'electron';
import { existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { AppSettings, SettingsPatch, ProviderId, ProviderStatus, RecentProject } from '@shared/api';
import { atomicWrite } from './project/fsutil';
import { canonicalDir } from '../runtime/policy';
import { PROVIDER_MODELS } from '@agent/models';
import type { LocalEndpoint } from '@agent/local';
import { checkLocalBaseURL, DEFAULT_LOCAL_SETTINGS } from '@shared/local';

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
const file = () => join(app.getPath('userData'), 'settings.json');

export async function loadSettings(): Promise<SettingsFile> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(await fs.readFile(file(), 'utf8')) as Partial<SettingsFile>;
    cache = {
      settings: { ...DEFAULTS.settings, ...raw.settings, ai: { ...DEFAULTS.settings.ai, ...raw.settings?.ai, models: { ...DEFAULTS.settings.ai.models, ...raw.settings?.ai?.models }, local: { ...DEFAULTS.settings.ai.local, ...raw.settings?.ai?.local } } },
      recents: raw.recents ?? [],
      trusted: raw.trusted ?? {}
    };
  } catch {
    cache = structuredClone(DEFAULTS);
  }
  return cache;
}

let writes: Promise<void> = Promise.resolve();

/** One write at a time, each of the latest state, so an older save can never land after a newer one. */
export function saveSettings(): Promise<void> {
  const run = writes.then(async () => {
    if (cache) await atomicWrite(file(), JSON.stringify(cache, null, 2));
  });
  writes = run.catch(() => undefined);
  return run;
}

export async function updateSettings(patch: SettingsPatch): Promise<AppSettings> {
  const s = await loadSettings();
  s.settings = { ...s.settings, ...patch, ai: { ...s.settings.ai, ...(patch.ai ?? {}), models: { ...s.settings.ai.models, ...(patch.ai?.models ?? {}) }, local: { ...s.settings.ai.local, ...(patch.ai?.local ?? {}) } } };
  await saveSettings();
  return s.settings;
}

export async function addRecent(dir: string, name: string) {
  const s = await loadSettings();
  // An older entry may name the same folder through a link.
  const real = canonicalDir(dir);
  s.recents = [{ dir, name, openedAt: new Date().toISOString() }, ...s.recents.filter((r) => r.dir !== dir && canonicalDir(r.dir) !== real)].slice(0, 20);
  await saveSettings();
}

export async function recents(): Promise<RecentProject[]> {
  const s = await loadSettings();
  return s.recents.map((r) => ({ ...r, missing: !existsSync(join(r.dir, 'siteorigin.project.json')) }));
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

/** Forget any trust given to `dir`: a new folder there (a project just unpacked) asks again before its tools run. */
export async function untrust(dir: string) {
  const s = await loadSettings();
  if (!(dir in s.trusted)) return;
  delete s.trusted[dir];
  await saveSettings();
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
  const keys = await readStoredKeys();
  if (key) keys[provider] = key.trim();
  else delete keys[provider];
  // Created with 0600 before the rename, so the keys are never briefly readable by other accounts.
  await atomicWrite(credFile(), JSON.stringify(keys), { mode: 0o600 });
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
      label: id === 'openai' ? 'OpenAI' : 'Anthropic',
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
    label: 'Local model',
    configured: url.ok,
    source: key?.source ?? null,
    storage: 'local-file',
    models: [],
    ...(url.ok && url.remote ? { warning: `Project content is sent to ${new URL(url.url).host}, which is not this computer.` } : {})
  });
  return out;
}

/** The saved local server. A model server the app runs itself can supply the same shape without Settings. */
export async function localEndpoint(): Promise<LocalEndpoint> {
  const { local, models } = (await loadSettings()).settings.ai;
  return { ...local, model: models.local, apiKey: (await getKey('local'))?.key ?? null };
}
