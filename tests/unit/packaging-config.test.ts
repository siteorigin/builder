// What electron-builder.yml puts in the packaged app's metadata (#824). The built Info.plist itself is checked by
// the packaged smoke test (tests/e2e/packaged.mjs).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// The YAML reader electron-builder itself loads this file with.
const { load } = createRequire(import.meta.url)('js-yaml') as { load(text: string): unknown };
const config = load(readFileSync('electron-builder.yml', 'utf8')) as {
  mac: { category: string; extendInfo?: Record<string, unknown> };
  linux: { category: string };
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

  it('files the app under graphics on macOS and Linux, not under developer tools', () => {
    expect(config.mac.category).toBe('public.app-category.graphics-design');
    expect(config.linux.category).toBe('Graphics;Publishing');
  });
});
