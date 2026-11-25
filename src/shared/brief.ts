/**
 * The project brief (#518): a short description and working notes that belong to the project and are private to it.
 * They are kept in a document of their own, so Duplicate project and a copied folder carry them while every export
 * leaves the one file out, and nothing that builds the website ever reads them.
 */
import type { ProjectBriefDoc } from './types';

/** Where the brief is kept, relative to the project folder. */
export const BRIEF_FILE = 'siteorigin/brief.json';

/** The two fields of a brief, as the editor and the brief's operation name them. */
export const BRIEF_FIELDS = ['description', 'notes'] as const;
export type BriefField = (typeof BRIEF_FIELDS)[number];

/** What a brief field holds: '' for a project without a brief, or a field it leaves out. */
export function briefText(brief: Partial<ProjectBriefDoc> | null | undefined, field: BriefField): string {
  const v = brief?.[field];
  return typeof v === 'string' ? v : '';
}

/** Whether a field holds anything worth keeping. A brief with nothing in either field is no document at all. */
export const briefFilled = (text: string): boolean => text.trim() !== '';

/**
 * The description a stored brief gives, for a Recent projects card: '' for a brief that is missing, damaged or empty,
 * so a card never fails over it.
 */
export function storedBriefDescription(text: string | null): string {
  if (!text) return '';
  try {
    const doc = JSON.parse(text) as unknown;
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? briefText(doc as Partial<ProjectBriefDoc>, 'description').trim() : '';
  } catch {
    return '';
  }
}
