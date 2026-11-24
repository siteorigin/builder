import type { ElementRef, OwnerRef, ProjectState } from '@shared/types';
import { STYLE_PROP_MAP } from '@shared/styles';
import { ownerLabel, refLabel } from './model';

/*
 * What History, Undo and Redo call a manual edit (#199): what was done, to which element, and where that element
 * is, so a long list of edits can be told apart: "Duplicate Split hero on Home", "Edit Heading on About",
 * "Set vertical padding for Logo in Header", "Delete Button in the Pricing card design". Each label is worked out
 * from the project as it was before the edit, by the action that knows what it acts on.
 */

/** Where an owner's elements are: "on Home", "in Header", "in the Pricing card design", "in the Posts layout". */
export function placeWords(state: ProjectState, owner: OwnerRef): string {
  if (owner.kind === 'page') return `on ${ownerLabel(state, owner).trim() || 'a page'}`;
  if (owner.kind === 'component') return `in the ${ownerLabel(state, owner)} design`;
  return `in ${owner.kind === 'template' ? 'the ' : ''}${ownerLabel(state, owner)}`;
}

/** An element (or a part of one) and where it is: "Split hero on Home", "Logo in Header". */
export function subjectWords(state: ProjectState, ref: ElementRef): string {
  return `${refLabel(state, ref)} ${placeWords(state, ref.owner)}`;
}

/** A change to one element, `detail` going between it and its place: "Move Gallery up on Home", "Rename Heading to Intro on About". */
export function editLabel(state: ProjectState, verb: string, ref: ElementRef, detail?: string): string {
  return `${verb} ${refLabel(state, ref)}${detail ? ` ${detail}` : ''} ${placeWords(state, ref.owner)}`;
}

/** Something done to an element, or to `part` of it: "Reset styles for Heading on About", "Reset overrides for Title in Split hero on Home". */
export function forLabel(state: ProjectState, what: string, ref: ElementRef, part?: string): string {
  return `${what} for ${part ? `${part} in ` : ''}${subjectWords(state, ref)}`;
}

/** A style property set on an element, or on `part` of it: "Set vertical padding for Split hero on Home". */
export function styleLabel(state: ProjectState, property: string, ref: ElementRef, part?: string): string {
  return forLabel(state, `Set ${(STYLE_PROP_MAP[property]?.label ?? property).toLowerCase()}`, ref, part);
}

/** A field of a placement or of an element changed: "Edit Heading in Split hero on About", "Edit link of Button in Footer". */
export function fieldLabel(state: ProjectState, field: string, ref: ElementRef, of = false): string {
  return `Edit ${field} ${of ? 'of' : 'in'} ${subjectWords(state, ref)}`;
}

/** The words for an element's content fields other than its text. */
const FIELD_WORDS: Record<string, string> = { iconPosition: 'icon position', ariaLabel: 'accessible name', collapseEmpty: 'empty hiding', appear: 'entrance', appearStagger: 'entrance stagger' };

/** A content field of an element changed: its text is the element itself ("Edit Heading on About"), any other field is named ("Edit link of Button on Home"). */
export function contentLabel(state: ProjectState, field: string, ref: ElementRef): string {
  return field === 'text' || field === 'label' ? editLabel(state, 'Edit', ref) : fieldLabel(state, FIELD_WORDS[field] ?? field, ref, true);
}

/** An element at the top of `owner`'s tree, as a reference to name it by. */
export const refTo = (owner: OwnerRef, nodeId: string): ElementRef => ({ owner, instancePath: [], nodeId });
