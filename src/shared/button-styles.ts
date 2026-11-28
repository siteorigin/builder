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

/**
 * Styles to put back to their theme values, in an order that never passes through a loop: each one after the styles
 * its theme value follows. Each reset is checked as it is made, and a theme default that follows a style the owner
 * made follow it back (Pill set to follow the button corners) is a loop until that style is put back too.
 */
export function resetOrder(ids: readonly string[], themeTokens: readonly TokenDef[]): string[] {
  const byId = new Map(themeTokens.map((t) => [t.id, t]));
  const depth = new Map<string, number>();
  const depthOf = (id: string, seen: Set<string> = new Set()): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const t = byId.get(id);
    const to = t ? linkOf(t.value, t.group) : null;
    // A theme's own links never loop; a loop or a link out of the theme counts as the end of the chain.
    const d = to && byId.has(to) && !seen.has(id) ? depthOf(to, seen.add(id)) + 1 : 0;
    depth.set(id, d);
    return d;
  };
  return ids.map((id, i) => ({ id, i, d: depthOf(id) })).sort((a, b) => a.d - b.d || a.i - b.i).map((x) => x.id);
}
