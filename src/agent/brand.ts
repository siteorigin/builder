/**
 * The site's brand in one call: name, tagline, contact details, colors, fonts and type scale. It compiles to one validated
 * batch that keeps site settings, the shared header and footer, and the derived color tokens in step.
 */
import { z } from 'zod';
import type { InstanceNode, LinkValue, ListItem, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { importedFontStack, projectFontFamilies } from '@shared/fonts';
import { READABLE_TEXT_COLORS, contrastBetween } from '@shared/contrast';
import { installedFonts, resolveFontStack } from '@catalogue/fonts';
import { effectiveTokens } from '@generator/index';
import { getTheme } from '@catalogue/index';
import { TYPE_SCALE_CHOICES, scaleRoles, typeScaleOps } from '@shared/type-scale';
import { normalizeLink } from '@engine/values';
import { contactInText } from '@shared/contact-links';
import { BRAND_PROP, COPYRIGHT_PROP, brandLabel, brandPlacements, followsSiteName } from '@shared/site-name';
import { fieldError, type FieldIssue } from './macros';
import type { JsonSchema } from './propschema';
import type { ToolHost, ToolOutcome } from './tools';

export const BRAND_ARGS = z.object({
  siteName: z.string().min(1).max(80).optional(),
  tagline: z.string().max(200).optional(),
  description: z.string().max(320).optional(),
  brandColor: z.string().max(9).optional(),
  accentColor: z.string().max(9).optional(),
  headingFont: z.string().max(60).optional(),
  bodyFont: z.string().max(60).optional(),
  typeScale: z.enum(TYPE_SCALE_CHOICES).optional(),
  contactEmail: z.string().max(120).optional(),
  contactPhone: z.string().max(30).optional(),
  copyright: z.string().max(200).optional()
});
export type BrandArgs = z.infer<typeof BRAND_ARGS>;

export const BRAND_DESCRIPTION =
  'Update the site brand in one call: the site name, tagline and contact details everywhere they appear (site settings, header, footer; a header or footer name or copyright line the author wrote themselves is kept), the brand color with its derived colors, fonts, and the type scale (the size of every heading and text style at once). Send only what changes. Fonts must be installed; an error lists the choices.';

export const BRAND_BRIEF = 'Set the site name, tagline and contact details everywhere they appear, the brand color with its derived colors, installed fonts, and the type scale (every heading and text size at once). Send only what changes.';

export function brandToolSchema(state: ProjectState): JsonSchema {
  const fonts = installedFontNames(state);
  const font = (description: string) => ({ type: 'string', enum: fonts, description });
  const color = (description: string) => ({ type: 'string', pattern: '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$', description });
  return {
    type: 'object',
    properties: {
      siteName: { type: 'string', maxLength: 80 },
      tagline: { type: 'string', maxLength: 200 },
      description: { type: 'string', maxLength: 320, description: 'Search engine description of the site.' },
      brandColor: color('Main brand color as hex. Hover, on-brand text and dark section colors follow it.'),
      accentColor: color('Accent color as hex.'),
      headingFont: font('Font for headings.'),
      bodyFont: font('Font for body text.'),
      typeScale: {
        type: 'string',
        enum: [...TYPE_SCALE_CHOICES],
        description: "Sizes of every heading and text style at once; fonts are kept. compact: modest and dense. balanced: clear steps, for most sites. editorial: large headings, roomy reading text. bold-display: dramatic headlines. theme: the theme's own sizes."
      },
      contactEmail: { type: 'string', maxLength: 120 },
      contactPhone: { type: 'string', maxLength: 30 },
      copyright: { type: 'string', maxLength: 200, description: 'Footer copyright line. Follows the site name if omitted.' }
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
const mix = (a: RGB, b: RGB, amount: number): RGB => [a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount, a[2] + (b[2] - a[2]) * amount];

const asRgb = (c: RGB) => ({ r: c[0], g: c[1], b: c[2] });

export function contrastRatio(a: RGB, b: RGB): number {
  return contrastBetween(asRgb(a), asRgb(b));
}

// The choices Site styles offers for unreadable text (src/shared/contrast.ts): white, the site's ink, black.
const [WHITE, INK, BLACK] = READABLE_TEXT_COLORS.map((h) => parseHex(h)!) as [RGB, RGB, RGB];

/**
 * The tokens that follow the brand color. Text on the brand takes whichever of white or ink reads better, and
 * the strong shade moves away from that text color, so filled and inverted buttons both stay legible.
 */
export function derivedBrandTokens(brand: string, onInverse: string): Record<string, string> {
  const base = parseHex(brand)!;
  // Mid-tones can miss 4.5:1 with both white and ink; pure black always reaches it where white does not.
  const onBrand = contrastRatio(WHITE, base) >= 4.5 ? WHITE : contrastRatio(INK, base) >= 4.5 ? INK : BLACK;
  const strong = mix(base, onBrand === WHITE ? BLACK : WHITE, 0.24);
  const light = parseHex(onInverse) ?? WHITE;
  let inverse = mix(base, INK, 0.82);
  for (let i = 0; i < 8 && contrastRatio(inverse, light) < 7; i++) inverse = mix(inverse, BLACK, 0.25);
  return { 'color.brand': toHex(base), 'color.brand-strong': toHex(strong), 'color.on-brand': toHex(onBrand), 'color.inverse': toHex(inverse) };
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
  const state = host.state();
  const issues: FieldIssue[] = [];
  const ops: EditOperation[] = [];
  const warnings: string[] = [];
  if (!Object.values(args).some((v) => v !== undefined)) return fieldError([{ field: 'arguments', message: 'send at least one brand field' }], 'Nothing was applied.');

  const tokens = new Map(effectiveTokens(state).map((t) => [t.id, t]));
  const setToken = (tokenId: string, value: string) => {
    if (tokens.has(tokenId) && tokens.get(tokenId)!.value !== value) ops.push({ type: 'token.set', tokenId, value });
  };
  if (args.brandColor !== undefined) {
    const base = parseHex(args.brandColor);
    if (!base) issues.push({ field: 'brandColor', message: `"${args.brandColor}" is not a hex color such as #1f5a4c` });
    else {
      for (const [id, v] of Object.entries(derivedBrandTokens(args.brandColor, resolvedColor(tokens, 'color.on-inverse') || '#ffffff'))) setToken(id, v);
      const bg = parseHex(resolvedColor(tokens, 'color.background'));
      if (bg && contrastRatio(base, bg) < 3) warnings.push(`${args.brandColor} has low contrast on the page background (${contrastRatio(base, bg).toFixed(1)}:1), so brand-colored text and icons may be hard to read.`);
    }
  }
  if (args.accentColor !== undefined) {
    const c = parseHex(args.accentColor);
    if (!c) issues.push({ field: 'accentColor', message: `"${args.accentColor}" is not a hex color such as #d98f48` });
    else setToken('color.accent', toHex(c));
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
    const target = type === 'tel' ? value.replace(/[^+0-9]/g, '') : value.trim();
    try {
      return normalizeLink({ type, target }, state, field);
    } catch (e) {
      issues.push({ field, message: (e as Error).message.replace(`${field}: `, '') });
      return null;
    }
  };
  const email = contactLink('contactEmail', args.contactEmail, 'email');
  const phone = contactLink('contactPhone', args.contactPhone, 'tel');
  if (issues.length) return fieldError(issues, 'Nothing was applied. Send the call again with these fields fixed.');

  if (args.siteName !== undefined || args.description !== undefined || (args.tagline !== undefined && !state.site.description)) {
    const description = args.description ?? (!state.site.description ? args.tagline : undefined);
    ops.push({ type: 'site.update', ...(args.siteName !== undefined ? { name: args.siteName } : {}), ...(description !== undefined ? { description } : {}) });
  }

  const setProp = (shell: 'header' | 'footer', node: InstanceNode, prop: string, value: unknown) => {
    if (Object.hasOwn(state.components[node.definitionId]?.properties ?? {}, prop) && node.props[prop] !== value) ops.push({ type: 'instance.setProp', owner: { kind: 'shell', id: shell }, nodeId: node.id, prop, value });
  };
  // The rename itself carries the name into the header and footer that showed the old one (shared/site-name.ts);
  // a label of the author's own stays, and the reply says where, so the model can mention it.
  const footer = shellInstance(state, 'footer');
  if (args.siteName !== undefined && args.siteName.trim() !== state.site.name) {
    for (const p of brandPlacements(state))
      if (followsSiteName(state, p.node, BRAND_PROP) === false) warnings.push(`The ${p.part} keeps its own name, “${brandLabel(p)}”, so it still shows that. Set its siteName with instance.setProp if it should change too.`);
  }
  // A line asked for goes in every footer that holds one, and wins over the line a rename in this call leaves, even
  // when it is the line there now.
  if (args.copyright !== undefined)
    for (const { part, node, def } of brandPlacements(state)) {
      if (part !== 'footer' || !Object.hasOwn(def.properties, COPYRIGHT_PROP)) continue;
      if (args.siteName !== undefined) ops.push({ type: 'instance.setProp', owner: { kind: 'shell', id: 'footer' }, nodeId: node.id, prop: COPYRIGHT_PROP, value: args.copyright });
      else setProp('footer', node, COPYRIGHT_PROP, args.copyright);
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
  if (!res.ok) return { ok: false, content: { ok: false, revision: res.revision, error: res.error } };
  return { ok: true, mutated: true, ops, results: res.results, content: { ok: true, revision: res.revision, changed: ops.length, ...(warnings.length ? { warnings } : {}) } };
}
