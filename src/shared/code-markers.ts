import { CODE_TEXT_ATTR } from './code-text';

/**
 * The editor's markers a code component's own Svelte may carry: attributes written in the code so the preview can
 * find what the editor edits there (each marked part, `data-so-part`, and each marked text, `data-so-text`). Both of
 * the project's exports take every one of them out of every code component's files, whoever owns the component, and
 * refuse a build that still carries one; the editable project keeps them. A new kind of marker is added here, and nowhere else.
 */
export const CODE_MARKER_ATTRIBUTES: readonly string[] = ['data-so-part', CODE_TEXT_ATTR];

/** Whether an attribute's name is one of the editor's code markers (HTML attribute names ignore case). */
export const isCodeMarker = (name: string): boolean => CODE_MARKER_ATTRIBUTES.includes(name.toLowerCase());

/** Whether text could hold a code marker at all, before it is read closely. */
export const mentionsCodeMarker = (text: string): boolean => {
  const lower = text.toLowerCase();
  return CODE_MARKER_ATTRIBUTES.some((a) => lower.includes(a));
};
