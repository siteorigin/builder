import { describe, expect, it } from 'vitest';
import { buildDetailsText, buildLabel, buildTime, buildVersion, readBuildStamp } from '../../src/main/build-info';

const NOW = new Date('2026-11-26T14:03:27.512Z');

describe('which build is running (#887)', () => {
  it('stamps a build with its commit and the time it was made', () => {
    const calls: string[][] = [];
    const stamp = readBuildStamp((args) => (calls.push(args), 'a1b2c3d4e5\n'), NOW);
    expect(stamp).toEqual({ commit: 'a1b2c3d4e5', builtAt: '2026-11-26T14:03:27.512Z' });
    expect(calls).toEqual([['rev-parse', '--short=10', 'HEAD']]);
  });

  it('still stamps the time when git cannot say the commit (no checkout, no git)', () => {
    const stamp = readBuildStamp(() => {
      throw new Error('not a git repository');
    }, NOW);
    expect(stamp).toEqual({ commit: null, builtAt: '2026-11-26T14:03:27.512Z' });
    expect(readBuildStamp(() => '  \n', NOW).commit).toBeNull();
  });

  it('shows the version with the commit and build time beside it, so two builds of one version can be told apart', () => {
    const a = buildVersion('0.1.0', { commit: 'a1b2c3d4e5', builtAt: '2026-11-26T14:03:27.512Z' });
    const b = buildVersion('0.1.0', { commit: 'a1b2c3d4e5', builtAt: '2026-11-27T09:00:00.000Z' });
    expect(a).toBe('0.1.0 (a1b2c3d4e5, built 2026-11-26 14:03 UTC)');
    expect(b).not.toBe(a);
    expect(buildLabel({ commit: 'f00ba12', builtAt: null })).toBe('f00ba12');
  });

  it('says so when a build carries no stamp (run unbundled) rather than passing for a real one', () => {
    expect(buildVersion('0.1.0', { commit: null, builtAt: null })).toBe('0.1.0 (commit unknown)');
    expect(buildTime('not a date')).toBeNull();
    expect(buildTime(null)).toBeNull();
  });

  it('copies the build, Electron and the operating system as plain lines for a report', () => {
    const text = buildDetailsText({ name: 'SiteOrigin Builder', version: '0.1.0', commit: 'a1b2c3d4e5', builtAt: '2026-11-26T14:03:27.512Z', electron: '45.4.1', platform: 'darwin', arch: 'arm64', osRelease: '25.4.0' });
    expect(text).toBe('SiteOrigin Builder 0.1.0 (a1b2c3d4e5, built 2026-11-26 14:03 UTC)\nElectron 45.4.1\ndarwin arm64 25.4.0');
  });
});
