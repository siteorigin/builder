import { app } from 'electron';
import { existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { AppSettings, SettingsPatch, ProviderId, ProviderStatus, RecentProject } from '@shared/api';
import { atomicWrite } from './project/fsutil';
import { PROVIDER_MODELS } from '@agent/models';

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
      models: { openai: PROVIDER_MODELS.openai[0].id, anthropic: PROVIDER_MODELS.anthropic[0].id },
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
      settings: { ...DEFAULTS.settings, ...raw.settings, ai: { ...DEFAULTS.settings.ai, ...raw.settings?.ai, models: { ...DEFAULTS.settings.ai.models, ...raw.settings?.ai?.models } } },
      recents: raw.recents ?? [],
      trusted: raw.trusted ?? {}
    };
  } catch {
    cache = structuredClone(DEFAULTS);
  }
  return cache;
}

export async function saveSettings() {
  if (cache) await atomicWrite(file(), JSON.stringify(cache, null, 2));
}

export async function updateSettings(patch: SettingsPatch): Promise<AppSettings> {
  const s = await loadSettings();
  s.settings = { ...s.settings, ...patch, ai: { ...s.settings.ai, ...(patch.ai ?? {}), models: { ...s.settings.ai.models, ...(patch.ai?.models ?? {}) } } };
  await saveSettings();
  return s.settings;
}

export async function addRecent(dir: string, name: string) {
  const s = await loadSettings();
  s.recents = [{ dir, name, openedAt: new Date().toISOString() }, ...s.recents.filter((r) => r.dir !== dir)].slice(0, 20);
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

// ---------------------------------------------------------------------------
// Credentials: kept in a local file readable only by the current user account. The app never uses the
// operating system keychain, so it never asks for keychain access. Never written to projects, logs or exports.
// ---------------------------------------------------------------------------

const credFile = () => join(app.getPath('userData'), 'api-keys.json');
const ENV_KEYS: Record<ProviderId, string> = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };

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
  await atomicWrite(credFile(), JSON.stringify(keys));
  await fs.chmod(credFile(), 0o600).catch(() => undefined);
}

/** Development builds may use provider keys from the environment as a documented override. */
function envKey(provider: ProviderId): string | undefined {
  if (app.isPackaged) return undefined;
  return process.env[ENV_KEYS[provider]] || undefined;
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
  return out;
}
