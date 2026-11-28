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

/**
 * What one batch of an AI run may change of the brief (#1407): the one field the assistant's update_project_brief call
 * composed, set to exactly the text it composed, while the field still holds `base`, the text it was composed from.
 * Given by that tool's own call, never by the model; the project refuses every other brief change from a run.
 */
export interface BriefWriteGrant {
  field: BriefField;
  text: string;
  base: string;
}

/** Why a batch asks for more than its brief grant allows, or null. `saved`: the brief as the project has it now. */
export function briefWriteRefusal(ops: readonly { type: string; description?: unknown; notes?: unknown }[], grant: BriefWriteGrant, saved: Partial<ProjectBriefDoc> | null | undefined): string | null {
  const op = ops[0];
  if (ops.length !== 1 || op?.type !== 'brief.update') return 'The brief tool changes the project brief alone, one field at a time.';
  const other: BriefField = grant.field === 'notes' ? 'description' : 'notes';
  if (op[other] !== undefined || op[grant.field] !== grant.text) return 'The brief tool writes only the change it composed.';
  if (briefText(saved, grant.field) !== grant.base) return 'The project brief changed since this change was composed. Read it again.';
  return null;
}
