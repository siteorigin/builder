/**
 * Site styles > Buttons (#1475). A theme opts in by declaring `radius.button` (the corners of every button it draws)
 * and `text.button` (their label: font, size, weight, case, letter spacing). They are ordinary corner and text styles,
 * edited, linked, written out and exported as any other; Buttons is the one place the panel shows them.
 */
import type { TokenDef, TokenGroup } from './types';
import { linkOf } from './styles';

export const BUTTON_RADIUS = 'radius.button';
export const BUTTON_TEXT = 'text.button';

/** The button styles a theme declares, each only when it is of its own kind. */
export function buttonStyleIds(themeTokens: readonly TokenDef[]): { radius: string | null; text: string | null } {
  const has = (id: string, group: TokenGroup) => themeTokens.some((t) => t.id === id && t.group === group);
  return { radius: has(BUTTON_RADIUS, 'radius') ? BUTTON_RADIUS : null, text: has(BUTTON_TEXT, 'text') ? BUTTON_TEXT : null };
}

/** The styles of a group that follow `id`, directly or through others of the group: a link from `id` to any of them would loop. */
export function tokenFollowers(tokens: readonly TokenDef[], id: string, group: TokenGroup): Set<string> {
  const out = new Set<string>();
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of tokens) {
      if (t.group !== group || out.has(t.id)) continue;
      const to = linkOf(t.value, group);
      if (to && (to === id || out.has(to))) (out.add(t.id), (grew = true));
    }
  }
  return out;
}
