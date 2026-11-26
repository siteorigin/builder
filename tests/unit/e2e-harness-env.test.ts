import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error the harness is plain JavaScript
import { launch, launchEnv } from '../e2e/harness.mjs';

describe('the e2e harness launch environment', () => {
  it('keeps the settings and Documents folders inside the run’s scratch folder', () => {
    const env = launchEnv('/scratch/run', {}, { SITEORIGIN_DOCUMENTS: '/Users/me/Documents', PATH: '/bin' });
    expect(env.SITEORIGIN_USER_DATA).toBe(join('/scratch/run', 'userdata'));
    expect(env.SITEORIGIN_DOCUMENTS).toBe(join('/scratch/run', 'documents'));
    expect(env.OPENAI_API_KEY).toBe('');
    expect(env.PATH).toBe('/bin');
  });

  it('lets a script override a provider key but never the Documents folder', () => {
    expect(launchEnv('/s', { OPENAI_API_KEY: 'k' }, {}).OPENAI_API_KEY).toBe('k');
    expect(launchEnv('/s', { SITEORIGIN_DOCUMENTS: '/elsewhere' }, {}).SITEORIGIN_DOCUMENTS).toBe(join('/s', 'documents'));
  });

  it('launch() hands the app that environment', async () => {
    let seen: Record<string, string> | undefined;
    await launch('/scratch/run', {}, {}, async (o: { env: Record<string, string> }) => ((seen = o.env), { app: {}, win: {}, errors: [] }));
    expect(seen?.SITEORIGIN_DOCUMENTS).toBe(join('/scratch/run', 'documents'));
  });
});
