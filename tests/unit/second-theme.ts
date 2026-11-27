/**
 * A second theme that is offered like a shipped one, for the tests of what the assistant's brand tool does when a
 * site switches themes. Only Foundation ships (the development fixture is never offered), so a test that needs a
 * theme to switch to registers this one beside the built-in packs.
 *
 * It is Foundation's contracts under its own identity, with what a switch must work out against the theme it lands
 * on: a font Foundation does not ship ("Test Mono") and the tinted eyebrow pill's colour pairs, which a mid-tone
 * brand cannot satisfy on a light or dark page.
 */
import type { ThemePack } from '@catalogue/pack';
import { createPack } from '@catalogue/dsl';
import { BUILTIN_PACKS, FOUNDATION_PACK } from '@catalogue/builtin';
import { registerPacks } from '@catalogue/index';
import { buildPack, fileSource } from '../../src/main/packs/build';
import { registerPackFiles } from '../../src/main/packs/files';

export const SECOND_THEME_ID = 'modern';
/** The font only the second theme ships. */
export const SECOND_THEME_FONT = { name: 'Test Mono', family: 'Test Mono Variable' };

const pill = (fg: string, ground: string) => ({ mix: [fg, 8, ground] as [string, number, string] });

function buildSecondTheme(): { pack: ThemePack; files: Map<string, string> } {
  const { components, ...meta } = FOUNDATION_PACK;
  const author = createPack({
    ...meta,
    id: SECOND_THEME_ID,
    name: 'Modern',
    description: 'Geometric and crisp, for product teams.',
    contrastPairs: [
      ...(meta.contrastPairs ?? []),
      { id: 'eyebrow-background', use: 'Eyebrow labels on the page', fg: 'color.brand', bg: pill('color.brand', 'color.background'), state: 'rest', group: 'brand-text', fixable: false },
      { id: 'eyebrow-surface-alt', use: 'Eyebrow labels on alternate sections', fg: 'color.brand', bg: pill('color.brand', 'color.surface-alt'), state: 'rest', group: 'brand-text', fixable: false },
      { id: 'eyebrow-dark', use: 'Eyebrow labels in dark sections', fg: 'color.accent', bg: pill('color.accent', 'color.inverse'), state: 'rest', group: 'dark-accent', fixable: false }
    ]
  });
  const { pack, files } = buildPack(author.define(components.map((c) => author.adopt(c))));
  // The extra font borrows Inter's files, which the pack ships.
  const inter = pack.fonts.find((f) => f.name === 'Inter')!;
  const mono = { ...inter, ...SECOND_THEME_FONT, category: 'monospace' as const, stack: `'${SECOND_THEME_FONT.family}', ui-monospace, monospace` };
  return { pack: { ...pack, fonts: [...pack.fonts, mono] }, files };
}

/** Register the built-in packs, their files, and the second theme. */
export function registerSecondTheme(): void {
  const built = [...BUILTIN_PACKS.map((a) => buildPack(a)), buildSecondTheme()];
  registerPacks(built.map((b) => b.pack));
  for (const { pack, files } of built) registerPackFiles(pack.id, new Map([...files].map(([k, abs]) => [k, fileSource(abs)])));
}
