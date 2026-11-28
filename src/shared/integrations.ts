/**
 * Integrations (#1485): services the website works with that Builder sets up from a setting or two, rather than the
 * author pasting their code. Each is stored under its own key of `site.integrations` while it is added, with only
 * what the author chose, and the generator writes its code into the published website's <head> (never the editor's
 * preview, so the author's own editing is never counted).
 *
 * Fathom Analytics, privacy-first visit counts: its script with the site's ID, following page changes made without
 * a reload (`data-spa="auto"`), as https://usefathom.com/docs/script/script-advanced describes.
 */
import type { SiteDoc, SiteIntegrations } from './types';

/** Where Fathom's script is served from. */
export const FATHOM_SCRIPT = 'https://cdn.usefathom.com/script.js';
/** The longest site ID kept. Fathom's are eight letters (its dashboard's "Site ID"). */
export const FATHOM_ID_MAX = 16;

/** The integrations Builder offers, in the order Site settings lists them. */
export const INTEGRATIONS = [{ id: 'fathom', name: 'Fathom Analytics', summary: 'Privacy-first visit counts, without cookies.' }] as const;

export type IntegrationId = (typeof INTEGRATIONS)[number]['id'];

/** A Fathom site ID as typed, without the space around it. */
export const fathomIdText = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Why a Fathom site ID cannot be used, or null when it can. */
export function fathomSiteIdProblem(id: string): string | null {
  const v = fathomIdText(id);
  if (!v) return 'Enter the site ID from Fathom’s site settings.';
  if (v.length > FATHOM_ID_MAX || !/^[A-Za-z0-9]{4,}$/.test(v)) return 'A Fathom site ID is a short code of letters and digits, such as ABCDEFGH.';
  return null;
}

/** The Fathom site ID the website uses: none while Fathom is not added, or its ID (a hand edit) cannot be used. */
export function fathomSiteId(site: Pick<SiteDoc, 'integrations'>): string | null {
  const fathom = site.integrations && typeof site.integrations === 'object' ? site.integrations.fathom : undefined;
  const id = fathom && typeof fathom === 'object' ? fathom.siteId : undefined;
  return typeof id === 'string' && !fathomSiteIdProblem(id) ? id.trim() : null;
}

/** Fathom's script tag for a site ID. The ID is letters and digits alone, so it needs no escaping. */
export const fathomTag = (siteId: string): string => `<script src="${FATHOM_SCRIPT}" data-site="${siteId}" data-spa="auto" defer></script>`;

/** The integrations added to the site, by ID, in the order Site settings lists them. */
export function addedIntegrations(site: Pick<SiteDoc, 'integrations'>): IntegrationId[] {
  const own = site.integrations && typeof site.integrations === 'object' ? (site.integrations as SiteIntegrations) : {};
  return INTEGRATIONS.filter(({ id }) => Object.hasOwn(own, id) && own[id] != null).map(({ id }) => id);
}

/** What the integrations add to the published website's <head>, one tag per line. */
export function integrationHead(site: Pick<SiteDoc, 'integrations'>): string {
  const fathom = fathomSiteId(site);
  return fathom ? fathomTag(fathom) : '';
}
