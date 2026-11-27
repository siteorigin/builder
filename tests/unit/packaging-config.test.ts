// What electron-builder.yml puts in the packaged app's metadata (#824). The built Info.plist itself is checked by
// the packaged smoke test (tests/e2e/packaged.mjs).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { PUBLISH_URL } from '../../scripts/release/feed';
import { selectArtifacts } from '../../scripts/release/generate-update-metadata';

// The YAML reader electron-builder itself loads this file with.
const { load } = createRequire(import.meta.url)('js-yaml') as { load(text: string): unknown };
const config = load(readFileSync('electron-builder.yml', 'utf8')) as {
  mac: { category: string; extendInfo?: Record<string, unknown>; target: string[] };
  linux: { category: string; target: string[]; extraResources?: Array<{ from: string; to: string }> };
  win: { target: string[]; extraResources?: Array<{ from: string; to: string }> };
  artifactName: string;
  publish: { provider: string; url: string };
};

describe('the packaged app’s metadata', () => {
  // Electron's stock Info.plist asks for all of these. The app denies those permissions, and electron-builder
  // drops a key that mac.extendInfo sets to null.
  it.each([
    'NSAudioCaptureUsageDescription',
    'NSBluetoothAlwaysUsageDescription',
    'NSBluetoothPeripheralUsageDescription',
    'NSCameraUsageDescription',
    'NSMicrophoneUsageDescription'
  ])('removes %s from the macOS bundle', (key) => {
    expect(config.mac.extendInfo).toHaveProperty(key, null);
  });

  it('ships the app icon beside the resources on Windows and Linux, where About and a Linux window read it (window-icon.ts)', () => {
    for (const platform of [config.win, config.linux]) expect(platform.extraResources).toContainEqual({ from: 'build/icon-flat.png', to: 'icon.png' });
  });

  it('files the app under graphics on macOS and Linux, not under developer tools', () => {
    expect(config.mac.category).toBe('public.app-category.graphics-design');
    expect(config.linux.category).toBe('Graphics;Publishing');
  });
});

// The release workflows publish what electron-builder writes, and the update feed lists it (docs/releasing.md).
describe('the installers the release feed lists', () => {
  it('builds an update zip beside the macOS DMG, which Squirrel.Mac installs updates from', () => {
    expect(config.mac.target).toEqual(expect.arrayContaining(['dmg', 'zip']));
  });

  it('bundles the download domain the release workflows publish to as the update feed', () => {
    expect(config.publish).toEqual({ provider: 'generic', url: PUBLISH_URL });
  });

  it('names each installer the way the feed generator picks them out, one per architecture', () => {
    const name = (os: string, arch: string, ext: string) =>
      config.artifactName.replace('${name}', 'siteorigin-builder').replace('${version}', '0.1.0').replace('${os}', os).replace('${arch}', arch).replace('${ext}', ext);
    expect(selectArtifacts('mac', [name('mac', 'arm64', 'zip'), name('mac', 'x64', 'zip'), name('mac', 'arm64', 'dmg')])).toEqual([
      'siteorigin-builder-0.1.0-mac-x64.zip',
      'siteorigin-builder-0.1.0-mac-arm64.zip'
    ]);
    expect(selectArtifacts('windows', [name('win', 'x64', 'exe')])).toEqual(['siteorigin-builder-0.1.0-win-x64.exe']);
    expect(selectArtifacts('linux', [name('linux', 'x86_64', 'AppImage')])).toEqual(['siteorigin-builder-0.1.0-linux-x86_64.AppImage']);
  });
});
