/**
 * Theme updates are asked for on every edit's snapshot (#966): telling an installed theme component from the theme's
 * current one compares their text, so a project whose theme components are all current hashes none of them. A changed
 * one is still found, and its lock still checked by its hash.
 */
import { describe, expect, it, vi } from 'vitest';

let hashed = 0;
vi.mock('@shared/sha256', async (load) => {
  const real = await load<typeof import('@shared/sha256')>();
  return {
    ...real,
    sha256Hex: (text: string) => {
      hashed++;
      return real.sha256Hex(text);
    }
  };
});

// The setup file has loaded the packs, and with them the hash, before this mock: the modules are loaded again with it.
vi.resetModules();
(await import('../../src/main/packs/build')).registerBuiltinPacks();
const { createStarterState } = await import('@catalogue/starters');
const { header } = await import('@catalogue/foundation/shell');
const { definitionHash } = await import('@shared/migrations');
const { themeUpdates } = await import('@engine/theme-updates');

describe('theme updates (#966)', () => {
  it('hash no installed theme component while every one is the theme’s own', () => {
    const s = createStarterState('business', 'Current', false);
    expect(Object.values(s.components).filter((d) => d.owner === 'theme').length).toBeGreaterThan(5);
    themeUpdates(s);
    hashed = 0;
    expect(themeUpdates(structuredClone(s))).toEqual({ available: [], kept: [] });
    expect(hashed).toBe(0);
  });

  it('still find a theme component that differs from the theme’s, and check its lock', () => {
    const s = structuredClone(createStarterState('business', 'Older', false));
    const installed = s.components[header.id];
    delete (installed.properties as Record<string, unknown>).ctaStyle;
    // Changed outside the theme: its lock names the theme's version, not this one.
    expect(themeUpdates(s).kept.map((k) => k.id)).toEqual([header.id]);
    // The theme's own older version: the lock names it, so the update is offered.
    s.themeLock.components[header.id].hash = definitionHash(installed);
    expect(themeUpdates(s).available.map((a) => a.id)).toContain(header.id);
  });
});
