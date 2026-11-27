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
import { getTheme, registerPacks } from '@catalogue/index';
import { packFileInfo, registerPackFiles, type PackFileSource } from '../../src/main/packs/files';
import { metaOf, restorePacks } from './fixtures/packs';

export const SECOND_THEME_ID = 'modern';
/** The font only the second theme ships. */
export const SECOND_THEME_FONT = { name: 'Test Mono', family: 'Test Mono Variable' };

const pill = (fg: string, ground: string) => ({ mix: [fg, 8, ground] as [string, number, string] });

/** The loaded Foundation's components and files under the second theme's identity, with its extra font and pairs. */
function secondTheme(): { pack: ThemePack; files: Map<string, PackFileSource> } {
  const foundation = getTheme('foundation');
  const author = createPack(
    metaOf(foundation, {
      id: SECOND_THEME_ID,
      name: 'Modern',
      description: 'Geometric and crisp, for product teams.',
      contrastPairs: [
        ...(foundation.contrastPairs ?? []),
        { id: 'eyebrow-background', use: 'Eyebrow labels on the page', fg: 'color.brand', bg: pill('color.brand', 'color.background'), state: 'rest', group: 'brand-text', fixable: false },
        { id: 'eyebrow-surface-alt', use: 'Eyebrow labels on alternate sections', fg: 'color.brand', bg: pill('color.brand', 'color.surface-alt'), state: 'rest', group: 'brand-text', fixable: false },
        { id: 'eyebrow-dark', use: 'Eyebrow labels in dark sections', fg: 'color.accent', bg: pill('color.accent', 'color.inverse'), state: 'rest', group: 'dark-accent', fixable: false }
      ]
    })
  );
  const { fonts: _fonts, ...authored } = author.define(foundation.components.map((c) => author.adopt(c)));
  void _fonts;
  // The extra font borrows Inter's files, which Foundation ships and so does this theme.
  const inter = foundation.fonts.find((f) => f.name === 'Inter')!;
  const mono = { ...inter, ...SECOND_THEME_FONT, category: 'monospace' as const, stack: `'${SECOND_THEME_FONT.family}', ui-monospace, monospace` };
  const files = new Map(foundation.fonts.flatMap((f) => f.faces).map((face) => [face.file, packFileInfo(foundation.id, face.file)!]));
  return { pack: { ...authored, fonts: [...foundation.fonts, mono], source: 'bundled' }, files };
}

/** Register the committed releases, their files, and the second theme. */
export async function registerSecondTheme(): Promise<void> {
  const packs = await restorePacks();
  const { pack, files } = secondTheme();
  registerPacks([...packs, pack]);
  registerPackFiles(pack.id, files);
}
