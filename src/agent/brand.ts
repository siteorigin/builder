/**
 * The site's brand in one call: its theme, name, tagline, contact details, colors, fonts and type scale. It compiles to
 * one validated batch that keeps site settings, the shared header and footer, and the derived color tokens in step.
 */
import { z } from 'zod';
import type { InstanceNode, LinkValue, ListItem, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { importedFontStack, projectFontFamilies } from '@shared/fonts';
import { contrastBetween, evaluatePairs, isFailing, pairsOf, relativeLuminance } from '@shared/contrast';
import { hasDarkPalette } from '@shared/color-scheme';
import { parseColor } from '@shared/color';
import { PALETTE_MOODS, PALETTE_MOOD_INFO, darkPins, darkSection, harmonizePalette, onBrandFor, paletteChanges, paletteSeed, strongShade } from '@shared/palette';
import { installedFonts, resolveFontStack } from '@catalogue/fonts';
import { effectiveTokens } from '@generator/index';
import { getTheme, listThemes } from '@catalogue/index';
import { applyOperations } from '@engine/apply';
import { TYPE_SCALE_CHOICES, scaleRoles, typeScaleOps } from '@shared/type-scale';
import { normalizeLink } from '@engine/values';
import { contactInText, dialString } from '@shared/contact-links';
import { isLanguageCode } from '@shared/languages';
import { checkPublicUrl } from '@shared/public-url';
import { BRAND_PROP, COPYRIGHT_PROP, brandLabel, brandPlacements, followsSiteName, siteNameText } from '@shared/site-name';
import { fieldError, type FieldIssue } from './macros';
import type { JsonSchema } from './propschema';
import type { ToolHost, ToolOutcome } from './tools';
import { applyFailure } from './result';

export const BRAND_ARGS = z.object({
  theme: z.string().max(40).optional(),
  siteName: z.string().min(1).max(80).optional(),
  tagline: z.string().max(200).optional(),
  description: z.string().max(320).optional(),
  brandColor: z.string().max(9).optional(),
  accentColor: z.string().max(9).optional(),
  headingFont: z.string().max(60).optional(),
  bodyFont: z.string().max(60).optional(),
  typeScale: z.enum(TYPE_SCALE_CHOICES).optional(),
  paletteMood: z.enum(PALETTE_MOODS).optional(),
  contactEmail: z.string().max(120).optional(),
  contactPhone: z.string().max(30).optional(),
  copyright: z.string().max(200).optional(),
  baseUrl: z.string().max(200).optional(),
  language: z.string().max(20).optional(),
  socialImage: z.string().max(200).optional()
});
export type BrandArgs = z.infer<typeof BRAND_ARGS>;

export const BRAND_DESCRIPTION =
  'Update the site brand in one call: the theme (the whole design; content is kept), the site name, tagline and contact details everywhere they appear (site settings, header, footer; a header or footer name or copyright line the author wrote themselves is kept), the brand color with its derived colors (paletteMood re-colors the whole site from it), fonts, and the type scale (the size of every heading and text style at once), and the site\'s public address, language and link preview image. Send only what changes. Fonts must be installed; an error lists the choices.';

export const BRAND_BRIEF = 'Switch the theme (the whole design; content stays), set the site name, tagline and contact details everywhere they appear, the brand color with its derived colors (paletteMood re-colors the whole site from it, or from the current brand; an accentColor sent stays), installed fonts, the type scale (every heading and text size at once), and the site address, language and link preview image. Send only what changes.';

/** The themes a site can switch to: every installed pack but its own theme and development fixtures. */
export function brandThemes(state: Pick<ProjectState, 'site'>) {
  return listThemes().filter((t) => !t.devOnly && t.id !== state.site.themeId);
}

export function brandToolSchema(state: ProjectState): JsonSchema {
  const fonts = installedFontNames(state);
  const themes = brandThemes(state);
  const font = (description: string) => ({ type: 'string', enum: fonts, description });
  const color = (description: string) => ({ type: 'string', pattern: '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$', description });
  return {
    type: 'object',
    properties: {
      ...(themes.length ? { theme: { type: 'string', enum: themes.map((t) => t.id), description: `Switch the site's design; content stays. ${themes.map((t) => `${t.id}: ${t.description}`).join(' ')}` } } : {}),
      siteName: { type: 'string', maxLength: 80 },
      tagline: { type: 'string', maxLength: 200 },
      description: { type: 'string', maxLength: 320, description: 'Search engine description of the site.' },
      brandColor: color('Main brand color as hex. Hover, on-brand text and dark section colors follow it.'),
      accentColor: color('Accent color as hex.'),
      headingFont: font('Font for headings.'),
      bodyFont: font('Font for body text.'),
      paletteMood: {
        type: 'string',
        enum: [...PALETTE_MOODS],
        description: `Re-color the whole site from the brand color, every pair readable. ${PALETTE_MOODS.map((m) => `${m}: ${PALETTE_MOOD_INFO[m].brief}`).join('; ')}. Without brandColor, uses the site's brand; an accentColor sent stays.`
      },
      typeScale: {
        type: 'string',
        enum: [...TYPE_SCALE_CHOICES],
        description: "Sizes of every heading and text style at once; fonts are kept. compact: modest and dense. balanced: clear steps, for most sites. editorial: large headings, roomy reading text. bold-display: dramatic headlines. theme: the theme's own sizes."
      },
      contactEmail: { type: 'string', maxLength: 120 },
      contactPhone: { type: 'string', maxLength: 30 },
      copyright: { type: 'string', maxLength: 200, description: 'Footer copyright line; {year} is this year. Follows the site name if omitted.' },
      baseUrl: { type: 'string', maxLength: 200, description: 'Public https:// address. "" clears it.' },
      language: { type: 'string', maxLength: 20, description: 'Language code, such as "en".' },
      socialImage: { type: 'string', maxLength: 200, description: 'Link preview image assetId. "" removes it.' }
    },
    additionalProperties: false
  };
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

/** Always available without loading anything. */
const SYSTEM_FONTS = ['system-ui', 'Georgia', 'ui-serif', 'ui-monospace'];

/** Every font a brand can use: the fonts installed with the site, the project's imported fonts, then system fonts. */
export function installedFontNames(state: ProjectState): string[] {
  return [...new Set([...installedFonts(state).map((f) => f.name), ...projectFontFamilies(state).map((f) => f.family), ...SYSTEM_FONTS])];
}

/** The font stack for a name, by the same rules as a font token, or an error naming the choices. */
export function fontStackFor(state: ProjectState, input: string): { stack: string } | { error: string } {
  const name = input.trim().replace(/^['"]|['"]$/g, '');
  const imported = projectFontFamilies(state).find((f) => f.family.toLowerCase() === name.toLowerCase());
  return imported ? { stack: importedFontStack(imported.family) } : resolveFontStack(state, name);
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

type RGB = [number, number, number];

function parseHex(v: string): RGB | null {
  const m = v.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const toHex = (c: RGB) => `#${c.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}`;

const asRgb = (c: RGB) => ({ r: c[0], g: c[1], b: c[2] });

export function contrastRatio(a: RGB, b: RGB): number {
  return contrastBetween(asRgb(a), asRgb(b));
}

/**
 * The tokens that follow the brand color, in OKLCH so a shade stays the brand's hue (src/shared/palette.ts). Text on
 * the brand takes white, the site's ink or black, the first that reads; the strong shade moves a perceptual step
 * away from that text, so filled and inverted buttons both stay legible; dark sections take the brand's hue, dark
 * enough for their text to read at 7:1.
 */
export function derivedBrandTokens(brand: string, onInverse: string): Record<string, string> {
  const base = toHex(parseHex(brand)!);
  const onBrand = onBrandFor(base);
  return { 'color.brand': base, 'color.brand-strong': strongShade(base, onBrand), 'color.on-brand': onBrand, 'color.inverse': darkSection(base, onInverse) };
}

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

/** The shell's own component: the placement that carries the site name. */
function shellInstance(state: ProjectState, shell: 'header' | 'footer'): InstanceNode | null {
  const tree = state.site.shell[shell];
  for (const id of tree.rootIds) {
    const n = tree.nodes[id];
    if (n?.kind === 'instance' && state.components[n.definitionId]?.properties.siteName) return n;
  }
  return null;
}

/** A token's value with references followed. */
function resolvedColor(tokens: Map<string, { value: unknown }>, id: string): string {
  let v = tokens.get(id)?.value;
  for (let i = 0; i < 8 && v && typeof v === 'object' && 'token' in v; i++) v = tokens.get(String((v as { token: unknown }).token))?.value;
  return typeof v === 'string' ? v : '';
}

export async function runBrand(args: BrandArgs, host: ToolHost, callId: string): Promise<ToolOutcome> {
  let state = host.state();
  const issues: FieldIssue[] = [];
  const ops: EditOperation[] = [];
  const warnings: string[] = [];
  if (!Object.values(args).some((v) => v !== undefined)) return fieldError([{ field: 'arguments', message: 'send at least one brand field' }], 'Nothing was applied.');

  // A theme switch goes first, and everything else in the call is worked out against the new theme (its fonts, its
  // colors, its text styles), so the batch reads as one change.
  if (args.theme !== undefined && args.theme !== state.site.themeId) {
    const choices = brandThemes(state);
    if (!choices.some((t) => t.id === args.theme)) issues.push({ field: 'theme', message: choices.length ? `"${args.theme}" is not an installed theme. Use one of: ${choices.map((t) => t.id).join(', ')}` : `"${args.theme}" is not an installed theme, and there is no other theme to switch to.` });
    else {
      const op: EditOperation = { type: 'theme.apply', themeId: args.theme };
      try {
        state = applyOperations(state, [op]).state;
        ops.push(op);
      } catch (e) {
        issues.push({ field: 'theme', message: (e as Error).message });
      }
    }
  }

  const tokens = new Map(effectiveTokens(state).map((t) => [t.id, t]));
  const setToken = (tokenId: string, value: string) => {
    if (tokens.has(tokenId) && tokens.get(tokenId)!.value !== value) ops.push({ type: 'token.set', tokenId, value });
  };
  const base = args.brandColor === undefined ? null : parseHex(args.brandColor);
  if (args.brandColor !== undefined && !base) issues.push({ field: 'brandColor', message: `"${args.brandColor}" is not a hex color such as #1f5a4c` });
  const accent = args.accentColor === undefined ? null : parseHex(args.accentColor);
  if (args.accentColor !== undefined && !accent) issues.push({ field: 'accentColor', message: `"${args.accentColor}" is not a hex color such as #d98f48` });
  if (args.paletteMood !== undefined) {
    // The whole palette from the brand, checked against every pair the theme sets: it replaces the four derived colors.
    const list = [...tokens.values()];
    const seed = base ? toHex(base) : args.brandColor === undefined ? paletteSeed(list) : null;
    if (args.brandColor === undefined && !seed) issues.push({ field: 'brandColor', message: "this site's brand color cannot be read; send brandColor with the palette mood" });
    if (seed && (args.accentColor === undefined || accent)) {
      const pairs = getTheme(state.site.themeId).contrastPairs ?? [];
      const palette = harmonizePalette({ brand: seed, mood: args.paletteMood, tokens: list, pairs, accent: accent ? toHex(accent) : undefined });
      const unreadable = palette.unreadable;
      // The accent is named only when it is what every unreadable pair hangs on, colors that follow it in the palette included.
      const proposed = list.map((t) => (Object.hasOwn(palette.values, t.id) && t.id !== 'color.accent' ? { ...t, value: palette.values[t.id as keyof typeof palette.values]! } : t));
      const accentPairs = new Set(pairsOf(pairs, 'color.accent', proposed).map((p) => p.id));
      const byAccent = !!accent && unreadable.every((r) => accentPairs.has(r.pair.id));
      const named = unreadable.map((r) => `${r.pair.use.toLowerCase()}${r.status === 'unknown' ? ' (cannot be checked)' : ''}`).join(', ');
      if (unreadable.length) issues.push({ field: byAccent ? 'accentColor' : 'paletteMood', message: `no ${args.paletteMood} palette keeps ${named} readable in this theme${byAccent ? ' with this accent color; send a lighter accentColor, or leave it out and one is made' : ''}` });
      else {
        // Only what the site does not show already: a link that still lands on the palette's color keeps following.
        const changes = paletteChanges(list, palette.values);
        for (const [id, v] of changes) setToken(id, v);
        // A dark palette visitors see keeps showing what it does: the colors it took from the light ones keep their present values.
        if (hasDarkPalette(state.tokens)) {
          for (const [tokenId, value] of darkPins(list, state.tokens.darkOverrides, changes.map(([id]) => id))) ops.push({ type: 'token.set', tokenId, value, scheme: 'dark' });
        }
        if (palette.adjusted) warnings.push(`${seed} was made ${relativeLuminance(asRgb(parseHex(palette.brand)!)) > relativeLuminance(asRgb(parseHex(seed)!)) ? 'lighter' : 'darker'} (${palette.brand}) so brand-colored links stay readable on the page, cards and sections; no page color can carry it as it was.`);
        if (palette.page === 'dark') warnings.push(`With ${palette.brand}, this theme's colors read only on dark backgrounds, so the site's backgrounds are now dark.`);
        if (hasDarkPalette(state.tokens)) {
          // Measured on the dark palette as the batch leaves it, against the theme now in use, beside how it read before the call.
          const before = host.state();
          // Only pairs that read before and do not now: one that could not be measured before has no change to report.
          const was = new Set(evaluatePairs(effectiveTokens(before, 'dark'), getTheme(before.site.themeId).contrastPairs ?? []).filter((r) => r.status !== 'pass').map((r) => r.pair.id));
          let fresh: string[] = [];
          try {
            const after = applyOperations(state, ops.filter((o) => o.type === 'token.set')).state;
            fresh = evaluatePairs(effectiveTokens(after, 'dark'), pairs).filter((r) => isFailing(r) && !was.has(r.pair.id)).map((r) => r.pair.use.toLowerCase());
          } catch {
            // The batch is checked as a whole when it is applied; a refusal there says why.
          }
          const remake = 'token.setColorScheme with regenerate: true makes the dark colors again from the new palette.';
          warnings.push(fresh.length ? `The dark palette kept its colors, and ${fresh.length === 1 ? 'one pair there is' : `${fresh.length} pairs there are`} now hard to read (${fresh.join(', ')}). ${remake}` : `The dark palette kept its colors. ${remake}`);
        }
      }
    }
  } else {
    if (base) {
      for (const [id, v] of Object.entries(derivedBrandTokens(args.brandColor!, resolvedColor(tokens, 'color.on-inverse') || '#ffffff'))) setToken(id, v);
      // The page background may be saved in any form a colour takes (a name, rgb()): only an opaque one is measured.
      const page = parseColor(resolvedColor(tokens, 'color.background'));
      const bg: RGB | null = page && page.a === 1 ? [page.r, page.g, page.b] : null;
      if (bg && contrastRatio(base, bg) < 3) warnings.push(`${args.brandColor} has low contrast on the page background (${contrastRatio(base, bg).toFixed(1)}:1), so brand-colored text and icons may be hard to read.`);
    }
    if (accent) setToken('color.accent', toHex(accent));
  }
  for (const [field, tokenId] of [['headingFont', 'font.display'], ['bodyFont', 'font.body']] as const) {
    const name = args[field];
    if (name === undefined) continue;
    const font = fontStackFor(state, name);
    if ('error' in font) issues.push({ field, message: font.error });
    else setToken(tokenId, font.stack);
  }
  if (args.typeScale !== undefined) {
    const themeTokens = getTheme(state.site.themeId).tokens;
    // The scale keeps each style's font, so a font changed in this same call still shows in every style.
    const scale = typeScaleOps([...tokens.values()], themeTokens, state.tokens.overrides, args.typeScale);
    const names = scale.unscalable.map((id) => `"${tokens.get(id)?.label ?? id}"`).join(', ');
    if (!scaleRoles(themeTokens, [...tokens.values()]).length) issues.push({ field: 'typeScale', message: "this site's theme has none of the text styles a type scale sets" });
    else if (scale.unscalable.length) issues.push({ field: 'typeScale', message: `${names} ${scale.unscalable.length === 1 ? 'has' : 'have'} a font or letter case that cannot be kept; the user can fix ${scale.unscalable.length === 1 ? 'it' : 'them'} in Site styles` });
    else ops.push(...scale.ops);
  }

  const contactLink = (field: 'contactEmail' | 'contactPhone', value: string | undefined, type: 'email' | 'tel'): LinkValue | null => {
    if (value === undefined) return null;
    if (type === 'tel' && /[a-z]/i.test(value)) {
      issues.push({ field, message: 'use digits only, without an extension' });
      return null;
    }
    const target = type === 'tel' ? dialString(value) : value.trim();
    try {
      return normalizeLink({ type, target }, state, field);
    } catch (e) {
      issues.push({ field, message: (e as Error).message.replace(`${field}: `, '') });
      return null;
    }
  };
  const email = contactLink('contactEmail', args.contactEmail, 'email');
  const phone = contactLink('contactPhone', args.contactPhone, 'tel');
  // How the site is found and shared, set with the brand so a rebrand ships complete.
  // A value the site already has is left out, so a call that changes nothing says so.
  const seo: { baseUrl?: string; language?: string; socialImage?: string | null } = {};
  if (args.baseUrl !== undefined) {
    // Checked first and compared as the site keeps it, so a spelling of the same address changes nothing, and an
    // address that cannot be used is refused even when the site already has it.
    const url = checkPublicUrl(args.baseUrl);
    if (!url.ok) issues.push({ field: 'baseUrl', message: url.message });
    else if (url.url !== (state.site.baseUrl ?? '')) seo.baseUrl = url.url;
  }
  if (args.language !== undefined) {
    if (!isLanguageCode(args.language.trim())) issues.push({ field: 'language', message: 'use a language code such as "fr" or "en-GB"' });
    else if (args.language.trim() !== state.site.language) seo.language = args.language.trim();
  }
  if (args.socialImage !== undefined) {
    const id = args.socialImage.trim();
    if (id && !(Object.hasOwn(state.assets.assets, id) && state.assets.assets[id].kind === 'image')) issues.push({ field: 'socialImage', message: `no library image has the assetId "${id}". Use an assetId search_assets returns, or "" to remove it` });
    else if ((id || null) !== (state.site.socialImage || null)) seo.socialImage = id || null;
  }
  if (issues.length) return fieldError(issues, 'Nothing was applied. Send the call again with these fields fixed.');

  const setProp = (shell: 'header' | 'footer', node: InstanceNode, prop: string, value: unknown) => {
    if (Object.hasOwn(state.components[node.definitionId]?.properties ?? {}, prop) && node.props[prop] !== value) ops.push({ type: 'instance.setProp', owner: { kind: 'shell', id: shell }, nodeId: node.id, prop, value });
  };
  // A line asked for goes in every footer that holds one. With a rename, the line is cleared first (an empty line names
  // no site, so the rename never grows a line about to be replaced) and set after it, so it wins as it was asked for.
  const footers = state.site.shell.footer.rootIds.map((id) => state.site.shell.footer.nodes[id]).filter((n): n is InstanceNode => n?.kind === 'instance' && state.components[n.definitionId]?.properties[COPYRIGHT_PROP]?.type === 'string');
  const copyright = (value: string): EditOperation[] => footers.filter((n) => args.siteName !== undefined || n.props[COPYRIGHT_PROP] !== value).map((n) => ({ type: 'instance.setProp', owner: { kind: 'shell', id: 'footer' }, nodeId: n.id, prop: COPYRIGHT_PROP, value }));
  if (args.copyright !== undefined && args.siteName !== undefined) ops.push(...copyright(''));
  if (args.siteName !== undefined || args.description !== undefined || (args.tagline !== undefined && !state.site.description) || Object.keys(seo).length) {
    const description = args.description ?? (!state.site.description ? args.tagline : undefined);
    ops.push({ type: 'site.update', ...(args.siteName !== undefined ? { name: args.siteName } : {}), ...(description !== undefined ? { description } : {}), ...seo });
  }
  if (args.copyright !== undefined) ops.push(...copyright(args.copyright));

  // The rename itself carries the name into the header and footer that showed the old one (shared/site-name.ts);
  // a label of the author's own stays, and the reply says where, so the model can mention it.
  const footer = shellInstance(state, 'footer');
  if (args.siteName !== undefined && siteNameText(args.siteName) !== state.site.name) {
    for (const p of brandPlacements(state))
      if (followsSiteName(state, p.node, BRAND_PROP) === false) warnings.push(`The ${p.part} keeps its own name, “${brandLabel(p)}”, so it still shows that. Set its siteName with instance.setProp if it should change too.`);
  }
  if (footer) {
    if (args.tagline !== undefined) setProp('footer', footer, 'tagline', args.tagline);

    const schema = state.components[footer.definitionId]?.properties.contact;
    if (schema?.type === 'list') {
      const list = (footer.props.contact as ListItem[] | undefined) ?? [];
      let room = schema.max === undefined ? Infinity : schema.max - list.length;
      for (const [link, label] of [[email, args.contactEmail], [phone, args.contactPhone]] as const) {
        if (!link) continue;
        const existing = list.find((i) => (i.link as LinkValue | undefined)?.type === link.type);
        const owner = { kind: 'shell' as const, id: 'footer' };
        // A deliberate label ("Call reception") stays: only the destination behind it changes.
        const custom = typeof existing?.label === 'string' && existing.label.trim() !== '' && !contactInText(existing.label);
        if (existing) ops.push({ type: 'instance.setProp', owner, nodeId: footer.id, prop: 'contact', itemId: existing.id, value: custom ? { link } : { label: label!.trim(), link } });
        else if (room-- > 0) ops.push({ type: 'instance.listInsert', owner, nodeId: footer.id, prop: 'contact', item: { label: label!.trim(), link } });
        else warnings.push(`The footer's contact list is full, so ${label} was not added.`);
      }
    }
  }

  if (!ops.length) return { ok: true, content: { ok: true, revision: host.revision(), note: 'The brand already matches.', ...(warnings.length ? { warnings } : {}) } };
  const res = await host.apply(ops, host.revision(), 'Update site brand', callId);
  if (!res.ok) return applyFailure(res);
  return { ok: true, mutated: true, ops, results: res.results, content: { ok: true, revision: res.revision, changed: ops.length, ...(warnings.length ? { warnings } : {}) } };
}
